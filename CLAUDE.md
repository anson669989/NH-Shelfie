# NH Shelfie

Capacitor + Vue 3 的 Android App：輸入 gallery ID，抓封面存本機，以資料夾分類。不經任何自建伺服器。完整設計見 README.md；本檔只記改程式時必須知道的事。

## 回報方式

- 一律用繁體中文、白話說明，使用者不是工程師
- 先講結論與需要使用者決定的事，再講細節
- 不要貼整段程式碼，只說改了哪些檔案、為什麼
- 需要使用者在手機上測試時，列出具體步驟

## 指令

- `npm install`：安裝依賴（首次後請 commit package-lock.json）
- `npm test`：Vitest 單元測試（改 parse.js / csv.js / 解析邏輯後必跑）
- `npm run build`：建置網頁到 dist/
- `npm run android:prepare`：build → 產生 android/ → 套用 patch → cap sync
- 驗證 APK：推到 GitHub 由 Actions 建置（`.github/workflows/build-apk.yml`），本機不一定有 Android SDK

## 架構（三層，禁止跨層）

- `src/components/*.vue`：介面層，只呼叫服務層，不直接碰 DB、檔案、網路
- `src/services/library.js`：服務層入口，唯一碰 SQLite 與檔案的地方
- `src/services/nhSource.js`：**唯一**對 nhentai 發請求與解析的地方；站方改版只改這裡；也是唯一 import `nh-webfetch` 的地方。使用 **API v2**（`/api/v2/galleries/{id}`、`/api/v2/cdn`，規格摘要見 `docs/tasks/004-api-v2.md` 第 5 節）；舊 `/api/gallery/{id}` 已停用
- `plugins/nh-webfetch/`：本地 Capacitor 外掛（Java），獨立隱藏 WebView 過 Cloudflare 後抓 API、驗證畫面、清 cookie；`cap sync` 自動納入，不需改 android/
- `src/services/parse.js`、`csv.js`、`errors.js`、`settingsMigration.js`：純函式，無 I/O，必須有單元測試
- `src/services/db.js`：連線與 schema 遷移
- `src/i18n.js`：所有介面字串（繁中 / English / 日本語）三份同步
- `scripts/patch-android.mjs`：對 `cap add android` 產生的專案套設定（含 App 圖示）；android/ 不進版控
- `scripts/gen-icons.mjs`：產生 App 圖示（紅底白書，只用 Node 內建模組）；要改圖示就改這裡

## 必守規則

1. **錯誤統一用錯誤碼**：服務層丟 `AppError(E.XXX)`，介面只用 `errText(err)` 顯示；新增錯誤碼要同時改 errors.js 和 i18n.js 三種語言的 `err.XXX`
2. **不留半套資料**：先存封面檔 → 單一交易寫 books / book_raw / book_folders；失敗要刪封面檔
3. **SQL 一律參數化**，不拼字串；列表查詢不可 SELECT book_raw
4. **外部文字一律純文字渲染**：禁用 v-html；CSP 在 index.html，改圖片來源要同步改 CSP
5. **只准 HTTPS 與白名單網域**；組網址只用整數 ID 套範本（`fillTemplate`）。唯一例外是封面：網址＝`/api/v2/cdn` 回傳且通過 `normalizeCdnServer` 的伺服器（https、`*.nhentai.net`）＋通過 `parseCoverPath` 正則的 `cover.path`，只能經 `buildCdnUrl` 組成；path 原樣使用，不可猜副檔名（站方會封鎖）
6. **所有站方請求經 nhSource 的 `schedule()` 節流**（同時 1 個、間隔 ≥ 3 秒；v2 詳情匿名上限 20 次／分鐘），不可繞過；不可在 `schedule()` 的工作內再呼叫會 `schedule()` 的函式（會互等卡死）
7. **schema 變更只能在 `MIGRATIONS` 陣列尾端新增版本**，不改舊版本
8. **新增 UI 字串三種語言都要補**；新增設定鍵要加進 settings.js 的 `DEFAULTS`
9. 不新增 Capacitor 外掛（例外：repo 內的本地外掛 `nh-webfetch`）、不加廣告或分析 SDK，不新增 Android 權限（目前只有 INTERNET）
10. Cloudflare challenge 特徵字串在 `parse.js` 的 `CHALLENGE_MARKERS` 與 `NhWebFetchPlugin.java` 各一份，改一邊要同步另一邊
11. 底部導覽與對話框要保留 safe-area insets（Android 15 edge-to-edge）
12. **寫檔前先建立上層資料夾**：`Filesystem.downloadFile` 不會自己建立（`recursive` 無效，會丟 ENOENT）；下載用 nhSource 的 `ensureParentDir`。檔案錯誤一律歸 `WRITE_FAILED`／`STORAGE_FULL`，不可歸成 `OFFLINE`（`classifyDownloadError`）

## 已知限制與待辦

### nhentai API v2 規則（站方規格，見 `docs/tasks/004-api-v2.md` 第 5 節）

- 詳情 `GET /api/v2/galleries/{id}`：匿名**每分鐘 20 次**（每個 IP），所以全域間隔 ≥ 3 秒；429 一律當退避訊號
- 請求要帶**具描述性的 User-Agent**：`NH-Shelfie/<版本> (+https://github.com/anson669989/NH-Shelfie)`
- 封面網址＝`GET /api/v2/cdn` 的 `thumb_servers` 主機＋詳情回應的 `cover.path`（原樣使用，副檔名可能是 `.jpg.webp`）；不寫死主機、不猜路徑，否則 CDN 會封鎖
- 主機順序：上次成功的主機（`cdn_last_host`）優先，其餘照 t1→t2→t3→t4；`/api/v2/cdn` 結果快取 24 小時
- 舊 `/api/gallery/{id}` 已停用（回 403「Use new API」→ `BAD_FORMAT`）；已存的 `api-v1` 資料仍可解析
- 本 App 不使用 API 金鑰或帳號

### 待實機驗收

- `docs/tasks/005-batch.md`：封面下載修正（先建資料夾）、白話錯誤訊息、清除封面快取、新圖示
- `docs/tasks/002-folder-dropdown.md`：資料夾下拉選單已實作，驗收清單尚未勾選

### 其他

- 已做：M1 路線 A MVP、M2 設定頁、M3 CSV、API v2、Cloudflare 備援 2（WebView 驗證抓取，現在只在原生被擋時才用）、隱藏開發者模式（關於 → 版本 連點 7 次）
- 未做：M4 詳情頁（標籤＋備註）、M5 標籤搜尋（tags / book_tags 以 `MIGRATIONS` 新增 v2，從 book_raw 本地解析）
- 未做：Cloudflare 備援 3（手動指定封面）、FLAG_SECURE、App 開啟鎖
- 任務 003 的 3.2–3.4（加強 Cloudflare 偵測）：v2 原生請求可用後暫不需要，原生再被擋時才做
- 沒有桌面預覽：SQLite / Filesystem 外掛只在 Android 運作，`npm run dev` 只能看靜態樣式；封面下載流程以 `tests/download-flow.test.js`（假檔案系統）測試

## 改完後的檢查清單

1. `npm test` 通過
2. `npm run build` 無錯誤
3. 動到服務層或資料表 → 說明是否需要 schema 遷移
4. 動到 i18n → 三種語言 key 一致
5. 簡述改了哪些檔案與原因，不要貼整個檔案
