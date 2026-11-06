package io.github.anson669989.nhwebfetch;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 以獨立、隱藏的 WebView（不接 Capacitor bridge）通過 Cloudflare 驗證後抓取 nhentai API。
 * 骨架階段：方法先回 UNIMPLEMENTED，用來驗證 cap sync 與 CI 建置能正確納入本外掛。
 */
@CapacitorPlugin(name = "NhWebFetch")
public class NhWebFetchPlugin extends Plugin {

    @PluginMethod
    public void fetchText(PluginCall call) {
        call.reject("not implemented", "UNIMPLEMENTED");
    }

    @PluginMethod
    public void showChallenge(PluginCall call) {
        call.reject("not implemented", "UNIMPLEMENTED");
    }

    @PluginMethod
    public void clearSession(PluginCall call) {
        call.reject("not implemented", "UNIMPLEMENTED");
    }
}
