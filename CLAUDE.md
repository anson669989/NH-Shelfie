# NH Shelfie

Capacitor + Vue 3 的 Android App：輸入 gallery ID，抓封面存本機，以資料夾分類。不經任何自建伺服器。完整設計見 README.md；本檔只記改程式時必須知道的事。

## 指令

- `npm install`：安裝依賴（首次後請 commit package-lock.json）
- `npm test`：Vitest 單元測試（改 parse.js / csv.js / 解析邏輯後必跑）
- `npm run build`：建置網頁到 dist/
- `npm run android:prepare`：build → 產生 android/ → 套用 patch → cap sync
- 驗證 APK：推到 GitHub 由 Actions 建置（`.github/workflows/build-apk.yml`），本機不一定有 Android SDK

## 架構（三層，禁止跨層）

- `src/components/*.vue`：介面層，只呼叫服務層，不直接碰 DB、檔案、網路
- `src/services/library.js`：服務層入口，唯一碰 SQLite 與檔案的地方
- `src/services/nhSource.js`：**唯一**對 nhentai 發請求與解析的地方；站方改版只改這裡；也是唯一 import `nh-webfetch` 的地方
- `plugins/nh-webfetch/`：本地 Capacitor 外掛（Java），獨立隱藏 WebView 過 Cloudflare 後抓 API、驗證畫面、清 cookie；`cap sync` 自動納入，不需改 android/
- `src/services/parse.js`、`csv.js`、`errors.js`：純函式，無 I/O，必須有單元測試
- `src/services/db.js`：連線與 schema 遷移
- `src/i18n.js`：所有介面字串（繁中 / English / 日本語）三份同步
- `scripts/patch-android.mjs`：對 `cap add android` 產生的專案套設定；android/ 不進版控

## 必守規則

1. **錯誤統一用錯誤碼**：服務層丟 `AppError(E.XXX)`，介面只用 `errText(err)` 顯示；新增錯誤碼要同時改 errors.js 和 i18n.js 三種語言的 `err.XXX`
2. **不留半套資料**：先存封面檔 → 單一交易寫 books / book_raw / book_folders；失敗要刪封面檔
3. **SQL 一律參數化**，不拼字串；列表查詢不可 SELECT book_raw
4. **外部文字一律純文字渲染**：禁用 v-html；CSP 在 index.html，改圖片來源要同步改 CSP
5. **只准 HTTPS 與白名單網域**；組網址只用整數 ID 套範本（`fillTemplate`）
6. **所有站方請求經 nhSource 的 `schedule()` 節流**（同時 1 個、間隔 ≥ 1 秒），不可繞過
7. **schema 變更只能在 `MIGRATIONS` 陣列尾端新增版本**，不改舊版本
8. **新增 UI 字串三種語言都要補**；新增設定鍵要加進 settings.js 的 `DEFAULTS`
9. 不新增 Capacitor 外掛（例外：repo 內的本地外掛 `nh-webfetch`）、不加廣告或分析 SDK，不新增 Android 權限（目前只有 INTERNET）
10. Cloudflare challenge 特徵字串在 `parse.js` 的 `CHALLENGE_MARKERS` 與 `NhWebFetchPlugin.java` 各一份，改一邊要同步另一邊
11. 底部導覽與對話框要保留 safe-area insets（Android 15 edge-to-edge）

## 已知限制與待辦

- **待實機驗收：`docs/tasks/001-cloudflare-webview.md`**——WebView 驗證抓取已實作（v0.1.1），CI 建置通過；尚待實機確認詳情 ✓、驗證畫面流程，以及封面（`t.nhentai.net`，仍走原生下載）是否也被擋。若封面也被擋，另開任務處理。
- **進行中：`docs/tasks/002-folder-dropdown.md`**——資料夾頁的橫向標籤列改成下拉選單（含資料夾管理）。與 001 一起在 v0.1.1 發佈。
- 已做：M1 路線 A MVP、M2 設定頁、M3 CSV
- 未做：M4 詳情頁（標籤＋備註）、M5 標籤搜尋（tags / book_tags 以 `MIGRATIONS` 新增 v2，從 book_raw 本地解析）
- 已做：Cloudflare 備援 2（WebView 驗證抓取）、隱藏開發者模式（關於 → 版本 連點 7 次）
- 未做：Cloudflare 備援 3（手動指定封面）、FLAG_SECURE、App 開啟鎖
- 沒有桌面預覽：SQLite / Filesystem 外掛只在 Android 運作，`npm run dev` 只能看靜態樣式

## 改完後的檢查清單

1. `npm test` 通過
2. `npm run build` 無錯誤
3. 動到服務層或資料表 → 說明是否需要 schema 遷移
4. 動到 i18n → 三種語言 key 一致
5. 簡述改了哪些檔案與原因，不要貼整個檔案
