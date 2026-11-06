# 任務 006：介面批次改版（v0.2.0）

> 目標版本：v0.2.0（CI 版本名 `0.2.0-dev.<建置編號>`）　·　建立：2026-11-07　·　前置：任務 005
> 狀態：**程式完成，待實機驗收**（第 5 節）；驗收通過後才推 `v0.2.0` 標籤發佈

## 1. 需求

1. **ID 輸入允許 # 開頭**：`#228922`、`# 228922`、前後空白、全形＃（含全形數字），以及原本的純數字與網址。
2. **加入書籍不用等網路（先存、後查）**：
   - 按「加入」只做本機動作：檢查 ID 格式 → 查本機資料庫：
     a. 已在目前選的資料夾 → 不重複加入，提示「已在此資料夾」；
     b. 已收藏但不在這個資料夾 → 把現有的書加進資料夾，提示「已加入（原本就在：A、B）」，不重抓；
     c. 沒收藏過 → 立刻寫入資料庫與資料夾，狀態「待補資料」，交給背景佇列。
   - 三種情況都立刻清空輸入框；書是否存在於網站一律由背景佇列判斷。
   - 詳細資料與封面都在背景佇列（存在資料庫，重開後繼續）；API 隊伍先補書名，成功後封面交給圖片隊伍；照加入順序。
   - 卡片依狀態顯示：待補資料（ID＋佔位圖＋「載入中」）→ 有書名沒封面 → 完整；每一步自動更新。
   - 404 → 「找不到這本」，單本選單有「修改 ID」與「刪除」；網路失敗留在佇列稍後自動重試，不算失敗。
   - 加入頁不再先查詢、不顯示封面預覽；下方顯示「最近加入」清單並自動更新；記住上次選的資料夾。
3. **資料夾頁多選模式**：長按進入並選取該本；點封面選取／取消（勾勾＋外框）；上方「已選 N 本」「全選」「取消」；下方「分類（可多選資料夾）」「從此資料夾移除（預設資料夾不顯示）」「從資料庫刪除（確認＋本數，刪封面檔）」；返回鍵退出多選；完成後自動退出並顯示結果。
4. **封面右上角「⋮」單本選單**：最上方完整標題（英文＋日文）與複製 ID；分類、從此資料夾移除（預設資料夾不顯示）、重抓封面、從資料庫刪除（確認）；按鈕夠大但不擋封面；多選模式中隱藏。
5. **封面下方顯示書名**：最多兩行、「…」截斷、寬度同封面；ID 仍在封面左下角；用 `title.pretty` → `english` → `japanese`；一律保留兩行高度。
6. **從瀏覽器「分享」直接加入**：冷啟動與背景執行都可；分享內容是網址或含網址的文字都能解析，多個 ID 取第一個；填入 ID、預選上次資料夾，按一下加入。intent-filter 寫進 `scripts/patch-android.mjs`。
7. **簡體中文 zh-CN**：全部字串翻譯（大陸用詞）；語言選單加「简体中文」；zh-CN／zh-Hans／zh-SG 自動用简中，zh-TW／zh-HK／zh-Hant 用繁中；測試檢查四語鍵一致。
8. **README 改版**：README.md（繁中）＋README.en.md（英文）給一般使用者；技術內容移到 `docs/DEVELOPMENT.md`。
9. **節流拆成兩條隊伍**：API（詳情、cdn，≥ 3 秒）與圖片（t1–t4）；圖片間隔依 `/api/v2/docs`（沒寫就 1 秒）；cdn 快取 24 小時，失敗或主機全掛才重新取得；429 時該隊伍暫停退避，畫面顯示「請求太頻繁，稍後自動重試」。

## 2. 使用者決定

- 分享功能：擴充本地外掛 `nh-webfetch`（不新增外掛），JS 端仍只由 `nhSource.js` 使用；CLAUDE.md 補上「nh-webfetch 也負責接收分享」。
- 分享進來只填入 ID＋預選上次資料夾，不先查詢（先存、後查）。
- 這次只推 main，手機測完沒問題再發 v0.2.0。

## 3. 圖片隊伍間隔的依據

2026-11-06 讀取 <https://nhentai.net/api/v2/openapi.json>（`2.0.0+4a31779`）：

- `GET /api/v2/galleries/{id}`：匿名 **20 次／分鐘／IP** → API 隊伍維持 ≥ 3 秒。
- `GET /api/v2/cdn`：規格未列速率限制。
- `cdn` 標籤說明：「Rate limits are generous for normal browsing. Brief bursts … are absorbed without 429s. Clients that sustain rates well beyond typical browsing … will be temporarily banned. Treat 429 as a backoff signal.」→ **沒有明文次數**，依需求採保守的 **1 秒**。

## 4. 實作

| 項目 | 做法 | 檔案 |
| --- | --- | --- |
| # 開頭 ID | `parseGalleryId` 先轉半形，接受 `#?\s*\d+`；新增 `extractGalleryId`（分享文字，取位置最前的 `/g/{id}` 或 `#id`） | `parse.js`、`tests/add-plan.test.js` |
| 加入判斷 | 純函式 `planAdd()`（new／already／addFolders）＋單元測試 a、b、c | `addPlan.js`、`tests/add-plan.test.js` |
| 先存、後查 | `quickAdd()` 只寫本機；背景 meta／cover 兩個工作者依 `queue_seq` 處理；429 依 `Retry-After` 暫停、網路失敗 30 秒重試、驗證時暫停、致命錯誤停下並顯示 | `library.js`、`QueueBanner.vue`、`App.vue` |
| schema v2 | `books.queue_seq`、新 `fetch_status` 值（`meta_pending`／`cover_pending`／`not_found`／`meta_failed`）；舊 `pending` 依是否有 api-v2 原始資料轉成 `cover_pending` 或 `meta_pending` | `db.js` |
| 兩條節流隊伍 | `makeLane()`：`apiLane`（3 秒）、`imgLane`（1 秒），各自的 429 暫停；四台主機都失敗時讓 cdn 快取過期 | `nhSource.js`、`tests/download-flow.test.js` |
| 多選模式 | 長按進入；`pushBackHandler` 讓返回鍵先退出；批次 `addBooksToFolders`／`removeBooksFromFolder`／`deleteBooks`（單一交易） | `FoldersPage.vue`、`CoverGrid.vue`、`ui.js`、`library.js` |
| ⋮ 選單 | 40×40 可點範圍、24px 圓點；標題用 `getBookTitles()`（單本讀 book_raw，`parseGallery` 新增 `titleEn`）；找不到時「修改 ID」（`changeBookId`） | `CoverGrid.vue`、`FoldersPage.vue`、`DialogHost.vue`、`library.js` |
| 書名 | 每格高度＝封面＋固定 36px 兩行 | `CoverGrid.vue`、`styles.css` |
| 分享 | `MainActivity` 加 `ACTION_SEND text/plain` intent-filter；外掛 `load()`／`handleOnNewIntent` 接收，`takeSharedText()` 取出即清除 | `NhWebFetchPlugin.java`、`patch-android.mjs`、`nhSource.js`、`library.js`、`AddPage.vue` |
| 简体中文 | 字串移到 `locales.js`（純資料），新增 zh-CN；`detectLang()`；測試檢查四語鍵與 `{變數}` 一致 | `locales.js`、`i18n.js`、`tests/locales.test.js` |
| README | 兩份使用者 README（截圖區以註解隱藏）、`docs/DEVELOPMENT.md`、`docs/images/icon.png` | 文件 |

## 5. 實機驗收清單

- [ ] 輸入 `#228922`、`＃228922`、`# 228922`、網址都能加入
- [ ] 按「加入」後輸入框立刻清空，「最近加入」先出現「載入中」，數秒後出現書名、再出現封面
- [ ] 同一本再加入同一資料夾 → 「已在此資料夾」；加入另一個資料夾 → 「已加入（原本就在：…）」
- [ ] 連續加入多本，封面照加入順序出現；關掉 App 重開會繼續補
- [ ] 不存在的 ID → 卡片顯示「找不到這本」，⋮ 有「修改 ID」「刪除」
- [ ] 飛航模式下加入 → 顯示「網路連不上，稍後自動重試」，關閉飛航後自動補上
- [ ] 收藏頁封面下方兩行書名，各列高度一致；⋮ 選單顯示英文＋日文完整標題、可複製 ID
- [ ] 長按進入多選、全選、分類／移除／刪除（確認框寫本數）、返回鍵退出多選
- [ ] 從瀏覽器分享 nhentai 頁面：App 關閉時與在背景時都會打開「新增」頁並填好 ID
- [ ] 設定 → 語言 → 简体中文；手機語言為简中時預設简中
- [ ] 從 v0.1.x 覆蓋安裝，舊收藏正常顯示（資料庫升級 v2）
