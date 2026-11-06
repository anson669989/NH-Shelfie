# 任務 001：Cloudflare 擋下詳情 API → 實作備援方案 2（WebView 驗證抓取）

> 目標版本：v0.1.1　·　前一版：v0.1.0（tag）　·　建立：2026-11-06
> 開始前先讀 `CLAUDE.md`；本任務要遵守其中所有「必守規則」。

## 1. 問題與證據

v0.1.0 安裝在實機（Samsung，Android 15）後，**設定 → 進階 → 測試連線** 顯示：

```
Success rate of last 5 fetches: 0% · BLOCKED×5
```

- `fetchDetail()` 每次都被判為 `E.BLOCKED`（HTTP 403 / 503 或回應是 HTML）。
- 原因：nhentai.net 整站（含 `/api/gallery/{id}`）在 Cloudflare JavaScript challenge 後面。原生 HTTP（`CapacitorHttp`）無法執行 JS，加手機 User-Agent 重試也無效（Cloudflare 也檢查 TLS 指紋等）。
- 其他開源客戶端回報相同狀況：一般 REST client 拿到 403；可行做法都是「用真正的瀏覽器引擎」。
- 封面伺服器（`t.nhentai.net` / `t1`–`t4`）據回報通常**沒有** challenge，但本專案尚未驗證（因為拿不到 `media_id`，從沒走到封面下載）。

這正是架構文件「最大風險：Cloudflare」與備援方案 1→2→3 的情境；方案 1（UA 重試）已實作且無效，本任務實作方案 2。

## 2. 不可違反的限制

- **不經任何自建伺服器**：不可用 FlareSolverr、代理或任何遠端服務。
- **android/ 不進版控**：它由 CI 以 `npx cap add android` 產生。任何原生 Kotlin/Java 程式碼**不能直接寫進 android/**，否則下次 CI 就消失。
- **外掛最少化**：優先自寫本地外掛；不引入不明第三方外掛。
- **只連白名單網域**（`nhentai.net` 及其子網域）、只用 HTTPS。
- **驗證用 WebView 必須與 App 本身的 WebView 隔離**：不可存取 Capacitor bridge；與 App 溝通的通道限定來源為 `https://nhentai.net`。
- 所有站方請求仍經 `nhSource.js` 的 `schedule()` 全局節流。
- 新增字串三種語言（zh-TW / en / ja）都要補。

## 3. 建議設計

### 3.1 本地 Capacitor 外掛 `nh-webfetch`

放在 repo 內、以本地套件引用，`npx cap sync` 會自動把它納入 Android 專案：

```
plugins/nh-webfetch/
  package.json            # name: nh-webfetch, "capacitor": { "android": { "src": "android" } }
  android/
    build.gradle
    src/main/AndroidManifest.xml
    src/main/java/io/github/anson669989/nhwebfetch/NhWebFetchPlugin.kt
  src/index.js            # registerPlugin('NhWebFetch')
```

根目錄 `package.json` 加 `"nh-webfetch": "file:./plugins/nh-webfetch"`。
（請先查證 Capacitor 7 本地外掛的正確結構與 `cap sync` 行為，再動手；不確定就在計畫中標出來。）

外掛 API（JS 端）：

```js
NhWebFetch.fetchText({ url, timeoutMs })      // → { status, contentType, body }
NhWebFetch.showChallenge({ url })             // 顯示可互動的驗證畫面，使用者通過或關閉後 resolve { passed: boolean }
NhWebFetch.clearSession()                     // 清除 nhentai 網域 cookie（設定頁「重設驗證」用）
```

原生端行為：

1. 建立一個**獨立、不顯示**的 WebView（不加入 Capacitor bridge），JS 開啟、使用系統預設 UA。
2. 載入 `https://nhentai.net/`，等頁面完成；若頁面標題或內容符合 Cloudflare challenge（如 `Just a moment...`、`cf-chl`、`challenge-platform`），最多等 15 秒讓它自動通過。
3. 通過後在該頁面以 `fetch(url, { credentials: 'include' })` 取得 API 文字，透過 **androidx.webkit `WebViewCompat.addWebMessageListener`**（`allowedOriginRules = ["https://nhentai.net"]`）回傳；不要用 `addJavascriptInterface` 暴露給所有來源。
4. 15 秒仍卡在 challenge → reject `CHALLENGE_REQUIRED`，由 JS 端決定是否呼叫 `showChallenge`。
5. `showChallenge`：以全螢幕對話框或 Activity 顯示同一個 WebView（或同 cookie store 的新 WebView），使用者完成驗證後偵測到非 challenge 頁面即自動關閉並回傳 `passed: true`。
6. Cookie 用 `CookieManager` 持久化；同一個 WebView 實例可重複使用（App 存活期間），閒置 5 分鐘可釋放。
7. 只允許載入 `nhentai.net` 及子網域；導向其他網域一律攔截（`shouldOverrideUrlLoading`）。

### 3.2 `nhSource.js` 修改

- 新增 `fetchMode` 設定：`auto`（預設）/ `native` / `webview`。存在 `settings`，加入 `DEFAULTS`。
- `auto`：記住上一次成功的方式；若最近一次原生請求是 `BLOCKED`，直接走 WebView，避免每次多打一個必失敗的請求。
- WebView 路徑一樣要經 `schedule()`、一樣交給 `parseGallery()`、一樣寫 `fetch_log`（`kind` 記 `detail-webview`）。
- `CHALLENGE_REQUIRED` → 新錯誤碼 `E.CHALLENGE`；介面收到時提示並提供「進行驗證」按鈕 → `showChallenge()` → 通過後自動重試一次。
- 封面：先維持原生 `Filesystem.downloadFile`。若實測封面也被擋（`COVER_FAILED` 且原因是 HTML/403），在本任務中記錄結果即可，另開任務處理，不要擴大範圍。
- 偵測 challenge 頁面的判斷寫成 `parse.js` 的純函式 `isChallengePage({ status, contentType, body })`，並補單元測試。

### 3.3 隱藏開發者模式（順便做）

- 設定頁「關於 → 版本」連點 7 次切換 `dev_mode`（存 settings，toast 提示開／關）。
- `dev_mode` 關閉時：進階區只顯示「測試連線」按鈕與結果（✓／✗＋白話原因）。
- `dev_mode` 開啟時：額外顯示「站方端點」、最近 50 次成功率與錯誤碼統計、`fetchMode` 切換、「重設驗證（清除 cookie）」。

## 4. 驗收條件

- [ ] `npm test` 全部通過，新增 `isChallengePage` 測試。
- [ ] `npm run build` 無錯誤。
- [ ] GitHub Actions 建置成功（`main` push）。
- [ ] 實機：測試連線「詳情 ✓」；若首次需要驗證，跳出驗證畫面，通過後自動重試成功。
- [ ] 實機：新增一本書完整流程成功（預覽封面 → 加入收藏 → 資料夾頁顯示 → 點封面開網頁）。
- [ ] 回報封面下載是否成功；失敗則記錄 HTTP 狀態與回應類型。
- [ ] 一般模式看不到端點與統計；連點版本號 7 次後出現。
- [ ] `CLAUDE.md` 的「已知限制與待辦」更新；README 功能表補一行說明驗證畫面。
- [ ] `package.json` 版本改為 `0.1.1`。

## 5. 建議工作順序

1. 用 Plan Mode 讀 `CLAUDE.md`、`src/services/nhSource.js`、`scripts/patch-android.mjs`，列出要新增／修改的檔案，等使用者確認。
2. 先做本地外掛骨架，確認 `npm run android:prepare` 後 `android/` 內看得到外掛（若本機沒有 Android SDK，以 push 到 GitHub 讓 Actions 建置來驗證）。
3. 實作原生 `fetchText`，再接 `nhSource.js`。
4. 實作 `showChallenge` 與介面提示。
5. 開發者模式。
6. 測試、文件、版本號。每完成一步就 commit。

## 6. 本機沒有 Android SDK 時

使用者的電腦不一定有 Android Studio。原生程式碼的編譯驗證以 GitHub Actions 為準：push 到分支 → 看 Actions 結果 → 失敗就讀紀錄修正。可用 `gh run list` / `gh run view --log-failed`（若已安裝 GitHub CLI）。
