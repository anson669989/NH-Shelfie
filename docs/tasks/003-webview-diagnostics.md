# 任務 003：WebView 抓取仍回 BLOCKED → 加診斷資訊並修正

> 目標版本：v0.1.1　·　建立：2026-11-06　·　前置：任務 001 已合併（commit 1d315f4、099dea6）
> 開始前先讀 `CLAUDE.md`、`docs/tasks/001-cloudflare-webview.md`。

## 1. 症狀

實機安裝 Actions #6 的測試版（App 顯示 `0.1.1-dev.6 (6)`），**設定 → 進階 → 測試連線**：

```
Detail: ✗ Temporarily unavailable, try again later    ← err.BLOCKED
Cover: —
```

- 沒有出現「需要先通過網站的安全驗證」（`err.CHALLENGE`），也**沒有跳出驗證畫面**。
- 也就是說 WebView 那條路有跑，但結果被歸類成 `E.BLOCKED`，而不是 `E.CHALLENGE`。

## 2. 可能原因（依 `nhSource.js` 目前的邏輯，只有兩條路會變成 BLOCKED）

| # | 路徑 | 會發生的情況 |
| --- | --- | --- |
| A | `mapWebFetchError()` 的預設分支 | 外掛回 `UNIMPLEMENTED`（**外掛沒被註冊進 Android 專案**）、`UNSUPPORTED`（WebView 太舊或 `WEB_MESSAGE_LISTENER` 不支援）、`BUSY` 等 |
| B | `interpretDetail()` | WebView 的 `fetch()` 拿到 403／503、HTML 或非 JSON，但內容**不符合** `CHALLENGE_MARKERS`（例如 Turnstile 新版頁面、在地化標題「請稍候…」、或 API 本身回 403 JSON） |

目前兩者都只留下 `BLOCKED`，原始錯誤碼、HTTP 狀態、回應內容都被丟掉，所以無法判斷是哪一個。**先加診斷，再修。**

另一個要排除的：`isReady()` 只靠字串比對判斷 challenge 是否通過。若 Cloudflare 頁面不含這些字，`isReady` 會在驗證還沒跑完時就回 true，接著 `fetch()` 拿到 403 → 走到 B。

## 3. 要做的事

### 3.1 診斷資訊（先做，單獨 commit、push，讓使用者回報）

- `nhSource.js` 保存最近一次 `fetchDetail` 的 **trace**（只存記憶體）：每次嘗試的 `via`、外掛錯誤 `code` 與 `message`、HTTP `status`、`contentType`、回應開頭 300 字（純文字）、`Capacitor.isPluginAvailable('NhWebFetch')`。
- 外掛 `fetchText` 成功或失敗時，附上 WebView 當下的 `href`、`title`，以及 `isReady` 判斷時看到的 `title`。
- 開發者模式下，「測試連線」結果對話框多一段「診斷」，並提供「複製」按鈕（`navigator.clipboard.writeText`），方便使用者貼給 Claude。
- `AppError` 保留 `cause`／`httpStatus`，不要在 `mapWebFetchError` 的預設分支吃掉原始 code。

### 3.2 手動驗證入口

- 開發者模式加一個「開啟驗證畫面」按鈕，直接呼叫 `showChallenge()`，讓使用者不論錯誤碼為何都能手動過一次驗證，再按「測試連線」。
- WebView 路徑若回 403／503 且為 HTML（即使不符合 markers），一律當作 `E.CHALLENGE`，讓介面提示驗證；只有原生路徑維持 `E.BLOCKED`。

### 3.3 改善 challenge 偵測（`NhWebFetchPlugin.java` 與 `parse.js` 同步）

- `PROBE_JS` 除了字串，也回報 DOM 特徵：`typeof window._cf_chl_opt !== 'undefined'`、`#challenge-form`、`#cf-challenge-running`、`[name="cf-turnstile-response"]`、`script[src*="/cdn-cgi/challenge-platform/"]`。任一成立就視為仍在驗證中。
- 補上在地化標題：`請稍候…`、`请稍候…`、`しばらくお待ちください`、`Verifying you are human`、`Checking your browser`。
- `isReady` 另加條件：nhentai 正常頁面的特徵（例如存在 `#content` 或站方的導覽列），兩者都看，避免把空白或中間頁當成已通過。

### 3.4 確認外掛真的被打包

- 在 Actions 的 `npx cap sync android` 輸出中確認 `nh-webfetch` 有出現在 Capacitor plugins 清單（可用 `gh run view <id> --log`）。若沒有，修正 `plugins/nh-webfetch/package.json` 或引用方式。
- 可在 workflow 的 sync 之後加一步：`grep -q nhwebfetch android/app/src/main/assets/capacitor.plugins.json || (echo "::error::nh-webfetch 未被註冊" && exit 1)`，讓之後漏掉時直接建置失敗。

## 4. 驗收條件

- [ ] 3.1 先單獨 push；使用者用開發者模式的「測試連線」取得診斷並回報。
- [ ] 依診斷結果修正後：測試連線「詳情 ✓」，或至少出現 `err.CHALLENGE` 並能跳出驗證畫面，通過後自動重試成功。
- [ ] 回報封面下載結果（✓ 或錯誤原因）。
- [ ] `npm test`、`npm run build` 通過，新增 challenge 偵測的單元測試；Actions 綠色。
- [ ] 一般模式（非開發者模式）不顯示診斷內容。
- [ ] push 前先問使用者。
