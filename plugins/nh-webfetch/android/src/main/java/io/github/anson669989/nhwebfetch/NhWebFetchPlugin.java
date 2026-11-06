package io.github.anson669989.nhwebfetch;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 以獨立的 WebView 通過 Cloudflare 驗證後抓取 nhentai API。
 *
 * 安全邊界：
 * - 這個 WebView 與 Capacitor 的 App WebView 完全分開：不接 bridge、不用 addJavascriptInterface。
 * - 回傳通道是 WebViewCompat.addWebMessageListener，只對 https://nhentai.net 主框架開放。
 * - 主框架只能導向 https://nhentai.net 與其子網域；Cloudflare 驗證需要的子資源（iframe / 腳本）放行。
 * - 抓取目標 url 只接受 https + nhentai 網域。
 *
 * 所有 WebView 操作都在主執行緒進行（plugin 方法本身在背景執行緒被呼叫）。
 *
 * 另外負責接收瀏覽器「分享」進來的文字（ACTION_SEND text/plain；intent-filter 由 scripts/patch-android.mjs 加到
 * MainActivity）：冷啟動時在 load() 讀 Activity 的 Intent，App 已在背景時由 handleOnNewIntent 接收並發出
 * shareReceived 事件；JS 端以 takeSharedText() 取出（取出即清除，不會重複處理）。
 */
@CapacitorPlugin(name = "NhWebFetch")
public class NhWebFetchPlugin extends Plugin {

    private static final String HOME = "https://nhentai.net/";
    private static final String ORIGIN = "https://nhentai.net";
    private static final String BRIDGE = "nhBridge";
    private static final long READY_WAIT_MS = 15_000;
    private static final long POLL_MS = 1_000;
    private static final long IDLE_RELEASE_MS = 5 * 60_000;
    private static final int DEFAULT_TIMEOUT_MS = 20_000;
    private static final int MAX_BODY_CHARS = 2_000_000;

    // 與 src/services/parse.js 的 CHALLENGE_MARKERS 同步
    private static final Pattern CHALLENGE_MARKERS = Pattern.compile(
        "Just a moment\\.\\.\\.|cf-chl|cf_chl_opt|challenge-platform|Attention Required! \\| Cloudflare",
        Pattern.CASE_INSENSITIVE
    );

    private static final String PROBE_JS =
        "(function(){try{var d=document.documentElement;return JSON.stringify({href:location.href,"
            + "state:document.readyState,title:document.title||'',html:d?d.outerHTML.slice(0,16384):''});}"
            + "catch(e){return JSON.stringify({href:'',state:'',title:'',html:''});}})()";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<Integer, FetchOp> pending = new HashMap<>();
    private final Runnable idleRelease = this::releaseWebView;
    private final Runnable pollChallengeTask = this::pollChallenge;

    private WebView webView;
    private FrameLayout hiddenHost;
    private boolean mainFrameError;
    private int nextReqId = 1;

    private Dialog challengeDialog;
    private PluginCall challengeCall;

    private static final class FetchOp {
        PluginCall call;
        String url;
        int timeoutMs;
        long readyDeadline;
        boolean loadStarted;
        boolean reloaded;
        boolean done;
        Runnable timeout;
        // 診斷用（任務 003）：最近一次 probe 看到的頁面、isReady 判定通過時的 title
        String probeHref = "";
        String probeTitle = "";
        String readyTitle;
        String stage = "probe";
    }

    // ------------------------------------------------------------------ 分享
    private static final int MAX_SHARE_CHARS = 4096;
    private String pendingShare;

    @Override
    public void load() {
        super.load();
        Activity activity = getActivity();
        if (activity != null) captureShare(activity.getIntent(), false);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        captureShare(intent, true);
    }

    private void captureShare(Intent intent, boolean notify) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return;
        StringBuilder sb = new StringBuilder();
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text != null) sb.append(text);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (subject != null) {
            if (sb.length() > 0) sb.append(' ');
            sb.append(subject);
        }
        // 標記為已處理：Activity 重建（例如旋轉螢幕）時不會再讀到同一筆分享
        intent.setAction(Intent.ACTION_MAIN);
        if (sb.length() == 0) return;
        String value = sb.length() > MAX_SHARE_CHARS ? sb.substring(0, MAX_SHARE_CHARS) : sb.toString();
        synchronized (this) {
            pendingShare = value;
        }
        if (notify) notifyListeners("shareReceived", new JSObject(), true);
    }

    /** 取出並清除尚未處理的分享文字；沒有時 text 為空字串。 */
    @PluginMethod
    public void takeSharedText(PluginCall call) {
        String value;
        synchronized (this) {
            value = pendingShare;
            pendingShare = null;
        }
        JSObject ret = new JSObject();
        ret.put("text", value == null ? "" : value);
        call.resolve(ret);
    }

    // ------------------------------------------------------------------ API

    @PluginMethod
    public void fetchText(PluginCall call) {
        String url = call.getString("url");
        if (!isAllowedUrl(url)) {
            call.reject("url not allowed", "INVALID_URL", baseDiag());
            return;
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            call.reject("WebView too old", "UNSUPPORTED", baseDiag());
            return;
        }
        FetchOp op = new FetchOp();
        op.call = call;
        op.url = url;
        op.timeoutMs = Math.max(5_000, Math.min(call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS), 60_000));
        main.post(() -> {
            if (challengeDialog != null) {
                call.reject("challenge screen is open", "CHALLENGE_REQUIRED", diag(op));
                return;
            }
            if (!ensureWebView()) {
                call.reject("no activity", "UNSUPPORTED", diag(op));
                return;
            }
            touch();
            op.readyDeadline = SystemClock.uptimeMillis() + READY_WAIT_MS;
            step(op);
        });
    }

    @PluginMethod
    public void showChallenge(PluginCall call) {
        String url = call.getString("url", HOME);
        if (!isAllowedUrl(url)) {
            call.reject("url not allowed", "INVALID_URL");
            return;
        }
        String title = call.getString("title", "nhentai.net");
        String closeLabel = call.getString("closeLabel", "×");
        main.post(() -> openChallenge(call, url, title, closeLabel));
    }

    @PluginMethod
    public void clearSession(PluginCall call) {
        main.post(() -> {
            CookieManager cm = CookieManager.getInstance();
            for (String host : new String[] { "https://nhentai.net", "https://www.nhentai.net" }) {
                String cookies = cm.getCookie(host);
                if (cookies == null) continue;
                for (String part : cookies.split(";")) {
                    int eq = part.indexOf('=');
                    String name = (eq >= 0 ? part.substring(0, eq) : part).trim();
                    if (name.isEmpty()) continue;
                    String expired = name + "=; Max-Age=0; Path=/";
                    cm.setCookie(host, expired);
                    cm.setCookie(host, expired + "; Domain=.nhentai.net");
                }
            }
            cm.flush();
            WebStorage.getInstance().deleteOrigin(ORIGIN);
            releaseWebView();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        main.post(this::releaseWebView);
        super.handleOnDestroy();
    }

    // ------------------------------------------------------------ fetchText

    private void step(FetchOp op) {
        if (op.done) return;
        if (webView == null) {
            finishReject(op, "webview released", "TIMEOUT");
            return;
        }
        webView.evaluateJavascript(PROBE_JS, raw -> {
            if (op.done) return;
            if (mainFrameError && op.loadStarted) {
                finishReject(op, "page load failed", "NETWORK");
                return;
            }
            JSONObject p = parseEvalResult(raw);
            if (p != null) {
                op.probeHref = p.optString("href");
                op.probeTitle = p.optString("title");
            }
            if (isReady(p)) {
                op.readyTitle = op.probeTitle;
                op.stage = "fetch";
                doFetch(op);
                return;
            }
            if (!op.loadStarted) {
                op.loadStarted = true;
                loadHome();
            } else if (SystemClock.uptimeMillis() > op.readyDeadline) {
                finishReject(op, "challenge not passed", "CHALLENGE_REQUIRED");
                return;
            }
            main.postDelayed(() -> step(op), POLL_MS);
        });
    }

    private void doFetch(FetchOp op) {
        int id = nextReqId++;
        pending.put(id, op);
        op.timeout = () -> {
            pending.remove(id);
            finishReject(op, "fetch timed out", "TIMEOUT");
        };
        main.postDelayed(op.timeout, op.timeoutMs);
        String js = "(function(){if(typeof " + BRIDGE + "==='undefined')return 'nobridge';"
            + "var id=" + id + ";"
            + "fetch(" + JSONObject.quote(op.url) + ",{credentials:'include',headers:{'Accept':'application/json'}})"
            + ".then(function(r){return r.text().then(function(t){"
            + "if(t.length>" + MAX_BODY_CHARS + "){throw new Error('too large');}"
            + BRIDGE + ".postMessage(JSON.stringify({id:id,status:r.status,"
            + "contentType:r.headers.get('content-type')||'',body:t}));});})"
            + ".catch(function(e){" + BRIDGE + ".postMessage(JSON.stringify({id:id,error:String(e)}));});"
            + "return 'ok';})()";
        webView.evaluateJavascript(js, res -> {
            if ("\"nobridge\"".equals(res)) {
                pending.remove(id);
                finishReject(op, "bridge unavailable", "UNSUPPORTED");
            }
        });
    }

    private void onBridgeMessage(String data) {
        JSONObject msg;
        try {
            msg = new JSONObject(data);
        } catch (Exception e) {
            return;
        }
        FetchOp op = pending.remove(msg.optInt("id", -1));
        if (op == null || op.done) return;
        main.removeCallbacks(op.timeout);
        if (msg.has("error")) {
            finishReject(op, msg.optString("error"), "NETWORK");
            return;
        }
        int status = msg.optInt("status", 0);
        String contentType = msg.optString("contentType", "");
        String body = msg.optString("body", "");
        boolean html = contentType.toLowerCase().contains("text/html");
        boolean challenge = CHALLENGE_MARKERS.matcher(head(body)).find() || ((status == 403 || status == 503) && html);
        if (challenge && !op.reloaded) {
            // cookie 過期：重新載入首頁讓 challenge 自動跑一次，再重試
            op.reloaded = true;
            op.loadStarted = true;
            op.stage = "probe";
            op.readyDeadline = SystemClock.uptimeMillis() + READY_WAIT_MS;
            loadHome();
            main.postDelayed(() -> step(op), POLL_MS);
            return;
        }
        if (challenge) {
            JSObject d = diag(op);
            d.put("status", status);
            d.put("contentType", contentType);
            d.put("bodyHead", body.length() > 300 ? body.substring(0, 300) : body);
            finishReject(op, "challenge not passed (after fetch)", "CHALLENGE_REQUIRED", d);
            return;
        }
        JSObject ret = diag(op);
        ret.put("status", status);
        ret.put("contentType", contentType);
        ret.put("body", body);
        op.done = true;
        op.call.resolve(ret);
        touch();
    }

    private void finishReject(FetchOp op, String message, String code) {
        finishReject(op, message, code, diag(op));
    }

    private void finishReject(FetchOp op, String message, String code, JSObject data) {
        if (op.done) return;
        op.done = true;
        if (op.timeout != null) main.removeCallbacks(op.timeout);
        op.call.reject(message, code, data);
        touch();
    }

    // ---------------------------------------------------------- diagnostics

    /** 不依賴 WebView 實例的資訊（任何執行緒皆可呼叫） */
    private JSObject baseDiag() {
        JSObject d = new JSObject();
        d.put("webMessageListener", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER));
        try {
            PackageInfo pkg = WebViewCompat.getCurrentWebViewPackage(getContext());
            if (pkg != null) d.put("webViewVersion", pkg.packageName + " " + pkg.versionName);
        } catch (Exception ignored) {
            // 取不到版本不影響主流程
        }
        return d;
    }

    /** fetchText 成功／失敗時附上的診斷資訊；只能在主執行緒呼叫 */
    private JSObject diag(FetchOp op) {
        JSObject d = baseDiag();
        String href = "";
        String title = "";
        if (webView != null) {
            href = webView.getUrl() != null ? webView.getUrl() : "";
            title = webView.getTitle() != null ? webView.getTitle() : "";
        }
        d.put("href", href);
        d.put("title", title);
        d.put("stage", op.stage);
        d.put("reloaded", op.reloaded);
        d.put("probeHref", op.probeHref);
        d.put("probeTitle", op.probeTitle);
        d.put("readyTitle", op.readyTitle != null ? op.readyTitle : "");
        d.put("mainFrameError", mainFrameError);
        return d;
    }

    // -------------------------------------------------------- showChallenge

    @SuppressLint("SetTextI18n")
    private void openChallenge(PluginCall call, String url, String title, String closeLabel) {
        if (challengeDialog != null) {
            call.reject("already open", "BUSY");
            return;
        }
        Activity activity = getActivity();
        if (activity == null || !ensureWebView()) {
            call.reject("no activity", "UNSUPPORTED");
            return;
        }
        main.removeCallbacks(idleRelease);
        challengeCall = call;

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(activity, 8);
        bar.setPadding(dp(activity, 16), pad, pad, pad);
        TextView titleView = new TextView(activity);
        titleView.setText(title);
        titleView.setTextColor(Color.BLACK);
        titleView.setTextSize(16);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        bar.addView(titleView, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button close = new Button(activity);
        close.setText(closeLabel);
        close.setAllCaps(false);
        bar.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        detach(webView);
        webView.getSettings().setBlockNetworkImage(false);
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // Android 15 edge-to-edge：內容避開系統列、瀏海與鍵盤
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets i = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime()
            );
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        Dialog dialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(root);
        dialog.setCancelable(true);
        dialog.setOnCancelListener(d -> finishChallenge(false));
        close.setOnClickListener(v -> finishChallenge(false));
        Window w = dialog.getWindow();
        if (w != null) w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        challengeDialog = dialog;
        dialog.show();

        mainFrameError = false;
        webView.loadUrl(url);
        main.postDelayed(pollChallengeTask, POLL_MS * 2);
    }

    private void pollChallenge() {
        if (challengeDialog == null || webView == null) return;
        webView.evaluateJavascript(PROBE_JS, raw -> {
            if (challengeDialog == null) return;
            if (isReady(parseEvalResult(raw))) {
                finishChallenge(true);
            } else {
                main.postDelayed(pollChallengeTask, POLL_MS);
            }
        });
    }

    private void finishChallenge(boolean passed) {
        Dialog dialog = challengeDialog;
        PluginCall call = challengeCall;
        challengeDialog = null;
        challengeCall = null;
        main.removeCallbacks(pollChallengeTask);
        if (webView != null) {
            detach(webView);
            webView.getSettings().setBlockNetworkImage(true);
            attachHidden();
        }
        if (dialog != null) {
            dialog.setOnCancelListener(null);
            dialog.dismiss();
        }
        if (passed) CookieManager.getInstance().flush();
        if (call != null) {
            JSObject ret = new JSObject();
            ret.put("passed", passed);
            call.resolve(ret);
        }
        touch();
    }

    // -------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private boolean ensureWebView() {
        if (webView != null) return true;
        Activity activity = getActivity();
        if (activity == null) return false;

        WebView wv = new WebView(activity);
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // Cloudflare 驗證腳本需要
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setBlockNetworkImage(true); // 背景抓取不需要圖片；驗證畫面時打開
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true); // 驗證 iframe 需要

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 主框架只能留在 nhentai.net；其他網域（含 intent:、http:）一律攔截
                return request.isForMainFrame() && !isAllowedUrl(request.getUrl().toString());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) mainFrameError = true;
            }
        });

        WebViewCompat.addWebMessageListener(
            wv,
            BRIDGE,
            Collections.singleton(ORIGIN),
            (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                if (!isMainFrame || !ORIGIN.equals(sourceOrigin.toString())) return;
                String data = message.getData();
                if (data != null) onBridgeMessage(data);
            }
        );

        webView = wv;
        attachHidden();
        return true;
    }

    /**
     * 不顯示的 WebView 仍掛在畫面上（1×1 px、透明、不可觸控），
     * 未掛載的 WebView 可能暫停計時器與繪製，Cloudflare 驗證會跑不完。
     */
    private void attachHidden() {
        Activity activity = getActivity();
        if (activity == null || webView == null) return;
        ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
        if (hiddenHost == null) {
            hiddenHost = new FrameLayout(activity);
            hiddenHost.setAlpha(0f);
            hiddenHost.setClickable(false);
            hiddenHost.setFocusable(false);
            hiddenHost.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        }
        if (hiddenHost.getParent() == null) decor.addView(hiddenHost, new FrameLayout.LayoutParams(1, 1));
        detach(webView);
        webView.setFocusable(false);
        hiddenHost.addView(webView, new FrameLayout.LayoutParams(1, 1));
    }

    private void loadHome() {
        mainFrameError = false;
        webView.loadUrl(HOME);
    }

    private void releaseWebView() {
        main.removeCallbacks(idleRelease);
        if (challengeDialog != null) finishChallenge(false);
        for (FetchOp op : pending.values()) {
            if (op.timeout != null) main.removeCallbacks(op.timeout);
            if (!op.done) {
                op.done = true;
                op.call.reject("webview released", "TIMEOUT");
            }
        }
        pending.clear();
        if (webView != null) {
            detach(webView);
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        if (hiddenHost != null && hiddenHost.getParent() instanceof ViewGroup) {
            ((ViewGroup) hiddenHost.getParent()).removeView(hiddenHost);
        }
        hiddenHost = null;
    }

    private void touch() {
        main.removeCallbacks(idleRelease);
        if (challengeDialog == null) main.postDelayed(idleRelease, IDLE_RELEASE_MS);
    }

    // -------------------------------------------------------------- helpers

    static boolean isAllowedUrl(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        String host = u.getHost();
        if (!"https".equalsIgnoreCase(u.getScheme()) || host == null) return false;
        host = host.toLowerCase();
        return host.equals("nhentai.net") || host.endsWith(".nhentai.net");
    }

    private static boolean isReady(JSONObject p) {
        if (p == null) return false;
        if (!isAllowedUrl(p.optString("href"))) return false;
        String state = p.optString("state");
        if (!"complete".equals(state) && !"interactive".equals(state)) return false;
        String text = p.optString("title") + "\n" + p.optString("html");
        return !CHALLENGE_MARKERS.matcher(text).find();
    }

    /** evaluateJavascript 的結果是 JSON 編碼後的值；我們的腳本回傳 JSON 字串，所以要解兩層。 */
    private static JSONObject parseEvalResult(String raw) {
        try {
            if (raw == null || "null".equals(raw)) return null;
            String s = new JSONArray("[" + raw + "]").getString(0);
            return new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    private static String head(String body) {
        return body.length() > 32_768 ? body.substring(0, 32_768) : body;
    }

    private static void detach(View v) {
        if (v.getParent() instanceof ViewGroup) ((ViewGroup) v.getParent()).removeView(v);
    }

    private static int dp(Activity a, int v) {
        return Math.round(v * a.getResources().getDisplayMetrics().density);
    }
}
