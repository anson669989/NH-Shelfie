# NH Shelfie

Capacitor + Vue 3 的 Android App：輸入 gallery ID，背景抓書名與封面存本機，以資料夾分類。不經任何自建伺服器。README.md／README.en.md 是給使用者看的介紹；技術設計見 `docs/DEVELOPMENT.md`；本檔只記改程式時必須知道的事。

## 回報方式

- 一律用繁體中文、白話說明，使用者不是工程師
- 先講結論與需要使用者決定的事，再講細節
- 不要貼整段程式碼，只說改了哪些檔案、為什麼
- 需要使用者在手機上測試時，列出具體步驟

## 指令

- `npm install`：安裝依賴（首次後請 commit package-lock.json）
- `npm test`：Vitest 單元測試（改 parse.js / csv.js / addPlan.js / locales.js / 解析邏輯後必跑）
- `npm run build`：建置網頁到 dist/
- `npm run android:prepare`：build → 產生 android/ → 套用 patch → cap sync
- 驗證 APK：推到 GitHub 由 Actions 建置（`.github/workflows/build-apk.yml`），本機不一定有 Android SDK

## 架構（三層，禁止跨層）

- `src/components/*.vue`：介面層，只呼叫服務層，不直接碰 DB、檔案、網路
- `src/services/library.js`：服務層入口，唯一碰 SQLite 與檔案的地方；背景佇列（meta／cover 兩個工作者）也在這裡
- `src/services/nhSource.js`：**唯一**對 nhentai 發請求與解析的地方；站方改版只改這裡；也是唯一 import `nh-webfetch` 的地方（含接收分享的 `takeSharedText`／`onShareReceived`）。使用 **API v2**（`/api/v2/galleries/{id}`、`/api/v2/cdn`，規格摘要見 `docs/tasks/004-api-v2.md` 第 5 節）；舊 `/api/gallery/{id}` 已停用
- `plugins/nh-webfetch/`：本地 Capacitor 外掛（Java），獨立隱藏 WebView 過 Cloudflare 後抓 API、驗證畫面、清 cookie；**nh-webfetch 也負責接收分享**（瀏覽器「分享」的 ACTION_SEND 文字；intent-filter 由 `patch-android.mjs` 加到 MainActivity）；`cap sync` 自動納入，不需改 android/
- `src/services/parse.js`、`csv.js`、`errors.js`、`settingsMigration.js`、`addPlan.js`：純函式，無 I/O，必須有單元測試
- `src/services/db.js`：連線與 schema 遷移
- `src/locales.js`：所有介面字串（繁中 zh-TW / 简中 zh-CN / English / 日本語）四份同步，純資料（`tests/locales.test.js` 檢查四語鍵一致）；`src/i18n.js` 只放 `t()`、`errText()` 與語言偵測
- `scripts/patch-android.mjs`：對 `cap add android` 產生的專案套設定（含 App 圖示、分享 intent-filter）；android/ 不進版控
- `scripts/gen-icons.mjs`：產生 App 圖示（紅底白書，只用 Node 內建模組）；要改圖示就改這裡（README 用的 `docs/images/icon.png` 也由它產生）

## 必守規則

1. **錯誤統一用錯誤碼**：服務層丟 `AppError(E.XXX)`，介面只用 `errText(err)` 顯示；新增錯誤碼要同時改 errors.js 和 locales.js 四種語言的 `err.XXX`
2. **不留半套資料**（「先存、後查」）：新書＋資料夾關聯一個交易寫入（`fetch_status = meta_pending`，沒有 book_raw 是正常狀態）；詳情與 book_raw 一個交易寫入；封面先存檔再更新資料庫，失敗或書已被刪就刪檔
3. **SQL 一律參數化**，不拼字串；列表查詢不可 SELECT book_raw（單本讀取可以，例如 ⋮ 選單的完整標題）
4. **外部文字一律純文字渲染**：禁用 v-html；CSP 在 index.html，改圖片來源要同步改 CSP
5. **只准 HTTPS 與白名單網域**；組網址只用整數 ID 套範本（`fillTemplate`）。唯一例外是封面：網址＝`/api/v2/cdn` 回傳且通過 `normalizeCdnServer` 的伺服器（https、`*.nhentai.net`）＋通過 `parseCoverPath` 正則的 `cover.path`，只能經 `buildCdnUrl` 組成；path 原樣使用，不可猜副檔名（站方會封鎖）
6. **所有站方請求經 nhSource 的兩條節流隊伍**（`makeLane`），不可繞過：
   - **API 隊伍**（`schedule()`＝`apiLane.run`）：詳情、`/api/v2/cdn`、驗證畫面；同時 1 個、間隔 ≥ 3 秒（v2 詳情匿名上限 20 次／分鐘）
   - **圖片隊伍**（`imgLane.run`）：t1–t4 封面；同時 1 個、間隔 ≥ 1 秒（`/api/v2/docs` 對 CDN 沒有明文次數，只說持續高速會被暫時封鎖、429 當退避訊號，所以採保守 1 秒）
   - 兩條隊伍互不卡住；收到 429 只暫停該隊伍（`lane.block`），背景佇列自動退避重試、畫面顯示「請求太頻繁，稍後自動重試」，不算失敗
   - 不可在某條隊伍的工作內再呼叫會排進**同一條**隊伍的函式（會互等卡死；例：`downloadCover` 在進圖片隊伍前先呼叫 `getThumbServers`）
7. **schema 變更只能在 `MIGRATIONS` 陣列尾端新增版本**，不改舊版本（目前到 v2）
8. **新增 UI 字串四種語言（zh-TW / zh-CN / en / ja）都要補**；新增設定鍵要加進 settings.js 的 `DEFAULTS`
9. 不新增 Capacitor 外掛（例外：repo 內的本地外掛 `nh-webfetch`）、不加廣告或分析 SDK，不新增 Android 權限（目前只有 INTERNET）
10. Cloudflare challenge 特徵字串在 `parse.js` 的 `CHALLENGE_MARKERS` 與 `NhWebFetchPlugin.java` 各一份，改一邊要同步另一邊
11. 底部導覽與對話框要保留 safe-area insets（Android 15 edge-to-edge）
12. **寫檔前先建立上層資料夾**：`Filesystem.downloadFile` 不會自己建立（`recursive` 無效，會丟 ENOENT）；下載用 nhSource 的 `ensureParentDir`。檔案錯誤一律歸 `WRITE_FAILED`／`STORAGE_FULL`，不可歸成 `OFFLINE`（`classifyDownloadError`）
13. **返回鍵順序**：關對話框 → `pushBackHandler` 註冊的處理（例如退出多選模式）→ 回資料夾頁 → 連按兩次離開

## 加入流程：「先存、後查」

- 按「加入」（`library.quickAdd`）**完全不發網路請求**：檢查 ID 格式 → 查本機 → `planAdd()` 決定 `already`（已在所選資料夾，提示）／`addFolders`（已收藏，只補資料夾，不重抓）／`new`（寫入 `meta_pending`）。三種情況都清空輸入框。書是否存在於網站一律由背景佇列判斷
- 背景佇列就是 `books.fetch_status` ＋ `queue_seq`（加入毫秒，排隊順序），存在資料庫，App 重開後繼續；只在前景執行，回到前景或網路恢復自動續跑
- 狀態：`meta_pending`（待補資料）→ `cover_pending`（有書名、待抓封面）→ `ok`；失敗：`not_found`（404，⋮ 可「修改 ID」）、`meta_failed`（格式不符）、`no_cover`（封面失敗，⋮ 可「重抓封面」）
- 網路失敗（離線／逾時／被擋）留在佇列 30 秒後自動重試；需要驗證時暫停並在提示列顯示「進行驗證」；寫檔／空間／資料庫錯誤停下並顯示
- 從瀏覽器分享進來一樣走這個流程：填入 ID（`extractGalleryId` 取第一個）、預選上次的資料夾，按「加入」

## 已知限制與待辦

### nhentai API v2 規則（站方規格，見 `docs/tasks/004-api-v2.md` 第 5 節）

- 詳情 `GET /api/v2/galleries/{id}`：匿名**每分鐘 20 次**（每個 IP），所以 API 隊伍間隔 ≥ 3 秒；429 一律當退避訊號
- `/api/v2/cdn` 與封面 CDN：規格沒有明文次數；圖片隊伍間隔 ≥ 1 秒
- 請求要帶**具描述性的 User-Agent**：`NH-Shelfie/<版本> (+https://github.com/anson669989/NH-Shelfie)`
- 封面網址＝`GET /api/v2/cdn` 的 `thumb_servers` 主機＋詳情回應的 `cover.path`（原樣使用，副檔名可能是 `.jpg.webp`）；不寫死主機、不猜路徑，否則 CDN 會封鎖
- 主機順序：上次成功的主機（`cdn_last_host`）優先，其餘照 t1→t2→t3→t4；`/api/v2/cdn` 結果快取 24 小時，四台都失敗時讓快取過期、下次重新取得
- 舊 `/api/gallery/{id}` 已停用（回 403「Use new API」→ `BAD_FORMAT`）；已存的 `api-v1` 資料仍可解析
- 本 App 不使用 API 金鑰或帳號

### 待實機驗收

- `docs/tasks/006-ui-batch.md`（v0.2.0）：# 開頭 ID、先存後查與背景佇列、多選模式、⋮ 單本選單、封面下方書名、從瀏覽器分享、简体中文、README 改版；手機測完沒問題才推 `v0.2.0` 標籤發佈
- `docs/tasks/005-batch.md`：封面下載修正（先建資料夾）、白話錯誤訊息、清除封面快取、新圖示
- `docs/tasks/002-folder-dropdown.md`：資料夾下拉選單已實作，驗收清單尚未勾選

### 其他

- 已做：M1 路線 A MVP、M2 設定頁、M3 CSV、API v2、Cloudflare 備援 2（WebView 驗證抓取，現在只在原生被擋時才用）、隱藏開發者模式（關於 → 版本 連點 7 次）
- 已做（006）：先存後查＋兩條節流隊伍、多選、⋮ 選單、分享加入、简体中文；schema v2＝`books.queue_seq` 與新的 `fetch_status` 值（舊 `pending` 自動轉換）
- 未做：M4 詳情頁（標籤＋備註）、M5 標籤搜尋（tags / book_tags 以 `MIGRATIONS` 新增 **v3**，從 book_raw 本地解析）
- 未做：Cloudflare 備援 3（手動指定封面）、FLAG_SECURE、App 開啟鎖
- 背景佇列只在前景執行（不加背景服務與權限）
- README 截圖區用 HTML 註解隱藏；`docs/screenshots/library.png`、`add.png`、`settings.png` 放好後移除兩份 README 的註解
- 任務 003 的 3.2–3.4（加強 Cloudflare 偵測）：v2 原生請求可用後暫不需要，原生再被擋時才做
- 沒有桌面預覽：SQLite / Filesystem 外掛只在 Android 運作，`npm run dev` 只能看靜態樣式；封面下載流程以 `tests/download-flow.test.js`（假檔案系統）測試

## 改完後的檢查清單

1. `npm test` 通過
2. `npm run build` 無錯誤
3. 動到服務層或資料表 → 說明是否需要 schema 遷移
4. 動到字串 → 四種語言 key 一致（`npm test` 的 locales 測試會檢查）
5. 簡述改了哪些檔案與原因，不要貼整個檔案
