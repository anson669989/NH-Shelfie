# NH Shelfie 開發文件

> 給開發者與維護者看的技術說明。一般使用說明請看 [README](../README.md)。

Capacitor + Vue 3 的 Android App：輸入 gallery ID，在背景抓書名與封面存到本機，以資料夾分類；不經任何自建伺服器。

## 功能一覽

| 頁面 | 功能 |
| --- | --- |
| 資料夾 | 頂部下拉選單切換「全部」「未分類」與自建資料夾（顯示本數）；封面牆（虛擬捲動，可調 2–5 欄），封面下方固定兩行書名、左下角 ID；每個資料夾各自記住排序；點封面以 Custom Tab 開網頁；封面右上角「⋮」單本選單（完整英／日標題、複製 ID、分類、從此資料夾移除、重抓封面、刪除；找不到的書可「修改 ID」）；長按封面進入多選模式（全選、批次分類／移除／刪除，返回鍵退出）；佔位圖依狀態顯示「載入中／找不到這本／資料讀取失敗／封面失敗」 |
| 新增 | 「先存、後查」：輸入 ID（純數字、`#228922`、全形＃、網址）→ 按「加入」只做本機動作（不發網路請求）→ 輸入框立刻清空；已在所選資料夾就提示、已收藏就只補資料夾；資料夾記住上次的選擇；下方「最近加入」清單隨背景補資料自動更新；從瀏覽器「分享」進來會自動填入 ID |
| 設定 | 主題顏色、深淺色、語言（繁中／简中／English／日本語）、使用說明；CSV 匯出／匯入（換機用）、背景佇列、重抓缺少的封面、封面占用空間、清除封面快取（只清暫存，收藏的封面不刪）；進階：測試連線；連點「關於 → 版本」7 次開啟開發者模式，可修改站方端點、看最近 50 次抓取成功率、切換抓取方式、重設驗證 |
| 驗證畫面 | 站方開啟 Cloudflare 安全驗證時，App 會先在背景 WebView 自動嘗試；過不了才在提示列出現「進行驗證」按鈕，開啟全螢幕驗證畫面讓你手動完成，通過後背景佇列自動續跑 |

## 資料來源：nhentai API v2

App 直接向站方的公開 API v2 取資料，不經任何自建伺服器、不需要帳號或 API 金鑰：

- 書的資料：`GET https://nhentai.net/api/v2/galleries/{id}`
- 封面：先用 `GET https://nhentai.net/api/v2/cdn` 取得封面主機清單（t1–t4，快取 24 小時；四台都失敗時讓快取過期、下次重新取得），再把主機接上書的資料裡的 `cover.path`。上次成功的主機會優先使用，失敗才依序換下一台。
- 站方限制（[`/api/v2/docs`](https://nhentai.net/api/v2/docs)）：詳情匿名每分鐘 20 次／IP，所以 API 請求至少間隔 3 秒；封面 CDN 沒有明文次數（「正常瀏覽很寬鬆、持續高速會暫時封鎖、429 一律當退避訊號」），圖片請求採保守的 1 秒間隔。請求都帶 `NH-Shelfie/<版本>` 的 User-Agent。
- 站方舊的 `/api/gallery/{id}` 已停用；舊版 App 存下的資料仍能讀取。

## 「先存、後查」加入流程與背景佇列

1. 按「加入」（`library.quickAdd`）只查本機：`planAdd()`（[`addPlan.js`](../src/services/addPlan.js)，純函式）判斷 `new`／`already`／`addFolders`。新書以單一交易寫 `books`（`fetch_status = 'meta_pending'`、`queue_seq` = 加入毫秒）與 `book_folders`。
2. 佇列就是 `books.fetch_status`，存在資料庫，App 重開後接著做；依 `queue_seq`（加入順序）處理。
   - **meta 工作者**（API 隊伍）：`meta_pending` → 抓詳情 → 單一交易寫 `books` 書名與 `book_raw` → `cover_pending`；404 → `not_found`；格式不符 → `meta_failed`。
   - **cover 工作者**（圖片隊伍）：`cover_pending` → 用本機 `book_raw` 組封面網址 → 下載 → 搬進 `covers/`（新檔名）→ 更新資料庫 → `ok`；封面失敗 → `no_cover`。
   - 離線／逾時／被擋：不算失敗，留在佇列 30 秒後自動重試；429：該隊伍暫停到 `Retry-After`（預設 30 秒）後自動續跑，畫面顯示「請求太頻繁，稍後自動重試」；需要驗證：暫停並顯示「進行驗證」。
   - 只在前景執行：切到背景就停，回到前景或網路恢復（`online` 事件）自動續跑。
3. 節流分兩條獨立隊伍（[`nhSource.js`](../src/services/nhSource.js) 的 `makeLane`）：API（詳情、`/api/v2/cdn`、驗證畫面，≥ 3 秒）與圖片（t1–t4，≥ 1 秒），封面下載不會卡住下一本的查詢。不可在某條隊伍的工作內再呼叫排進同一條隊伍的函式。

## 從瀏覽器「分享」加入

- [`scripts/patch-android.mjs`](../scripts/patch-android.mjs) 在 `MainActivity` 加上 `ACTION_SEND text/plain` 的 intent-filter（`launchMode="singleTask"`）。
- 本地外掛 `nh-webfetch` 也負責接收分享：冷啟動時在 `load()` 讀 Intent，App 在背景時由 `handleOnNewIntent` 接收並發出 `shareReceived`；JS 以 `takeSharedText()` 取出（取出即清除）。只有 `nhSource.js` 使用這個外掛。
- `extractGalleryId()` 從分享文字找出第一個 ID（`/g/{id}`、`#123456` 或整段數字），加入頁填入 ID、維持上次的資料夾，按「加入」即完成。

## 實作重點

- **轉接層**：所有對站方的請求與解析集中在 [`src/services/nhSource.js`](../src/services/nhSource.js)，對內只輸出固定的 BookMeta；端點範本存在 settings，可在設定頁修改。舊 API（`raw_format = api-v1`）的已存資料仍可解析。
- **原生網路**：下載封面前一定先建立目標資料夾（`downloadFile` 不會自己建立）；詳情先走 `CapacitorHttp`（帶 `NH-Shelfie/<版本> (+https://github.com/anson669989/NH-Shelfie)` User-Agent）；被 Cloudflare 擋下時改用本地外掛 [`plugins/nh-webfetch`](../plugins/nh-webfetch) 的獨立 WebView（不接 Capacitor bridge，回傳通道只對 `https://nhentai.net` 開放）在站方頁面內抓 API。封面用 `Filesystem.downloadFile` 原生下載到快取目錄（不經 base64 橋接），成功後搬進 `covers/`。
- **不留半套資料**：新書與資料夾關聯一個交易寫入；詳情與 `book_raw` 一個交易寫入；封面先存檔再更新資料庫，失敗或書已被刪就刪檔。啟動時清掉孤兒封面檔。
- **資料模型**：SQLite（`books`、`book_raw`、`folders`、`book_folders`、`settings`、`fetch_log`），`raw_json` 獨立存放並以 `raw_format` 標版本，日後做標籤搜尋（路線 B）可直接本地解析、不必重抓。schema 以 `PRAGMA user_version` 逐版遷移，遷移前自動備份。v2 新增 `books.queue_seq` 與新的 `fetch_status` 值（`meta_pending`、`cover_pending`、`not_found`、`meta_failed`），舊的 `pending` 自動轉換。
- **安全**：所有外部文字一律純文字渲染（不使用 `v-html`）；CSP 只允許自身腳本與本機圖片；只允許 HTTPS、請求只送往白名單網域；ID 先轉整數再套範本，封面網址只接受 `*.nhentai.net` 的 CDN 伺服器與符合格式的 `cover.path`；封面以檔頭驗證 JPG／PNG／WebP、上限 5 MB；全部參數化查詢；CSV 匯出防公式注入；只申請 `INTERNET` 權限；關閉 `allowBackup`；封面目錄放 `.nomedia`。
- **Android 細節**：safe-area insets 處理 Android 15 edge-to-edge；返回鍵順序：關彈窗 → 退出多選 → 回資料夾頁 → 再按一次才離開。
- **語言**：字串在 [`src/locales.js`](../src/locales.js)（繁中／简中／English／日本語），`tests/locales.test.js` 檢查四語鍵一致；手機語言 zh-CN／zh-Hans／zh-SG 自動用简中，zh-TW／zh-HK／zh-Hant 用繁中。

## 已知限制

- 依賴站方 API v2：站方改格式或改限制時，書會顯示「資料讀取失敗」，需要更新 App（或在開發者模式改端點）。
- 匿名每分鐘 20 次的限制下，大量加入或 CSV 匯入後補資料比較慢（每本約 3 秒；封面另走圖片隊伍）。
- 站方若開啟 Cloudflare 驗證，需要在 App 內手動完成一次驗證畫面。
- 背景佇列只在前景執行（不新增 Android 權限、不用背景服務）。
- 沒有桌面預覽：資料庫與檔案功能只在 Android 上運作。

## 尚未包含（依里程碑之後再做）

- M4 詳情頁（標籤顯示＋個人備註）、M5 路線 B（標籤搜尋與篩選）
- Cloudflare 備援方案 3（手動指定封面）
- 隱藏最近使用畫面（FLAG_SECURE）、App 開啟鎖、自動覆寫 CSV 到指定資料夾
- iOS 版

## 發佈新版本（GitHub Actions 自動建置 APK）

工作流程檔：[`.github/workflows/build-apk.yml`](../.github/workflows/build-apk.yml)

| 觸發 | 產出 |
| --- | --- |
| push 到 `main`、PR、手動執行 | 跑單元測試並建置 APK，放在該次 Actions 的 **Artifacts**（測試用） |
| push 標籤 `v*`（如 `v0.1.0`） | 建置**已簽章**的 release APK，自動建立 GitHub Release 並附上 `nh-shelfie.apk` |

### 1. 設定簽章金鑰（只需做一次）

Android 只允許「同一把金鑰簽章」的 APK 覆蓋更新，所以發佈前必須準備一把固定的金鑰。

```bash
# 產生金鑰（需安裝 JDK；依提示設定密碼）
keytool -genkeypair -v -keystore release.jks -alias nhcollection \
  -keyalg RSA -keysize 2048 -validity 10000

# 轉成 base64（macOS 用 base64 -i release.jks | pbcopy）
base64 -w0 release.jks > release.jks.b64
```

到 GitHub 儲存庫 **Settings → Secrets and variables → Actions → New repository secret** 新增四個 secrets：

| 名稱 | 內容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `release.jks.b64` 的內容 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密碼 |
| `ANDROID_KEY_ALIAS` | `nhcollection`（或你設定的 alias） |
| `ANDROID_KEY_PASSWORD` | key 密碼（未另外設定時與 keystore 密碼相同） |

> 🔐 `release.jks` 與密碼請另外備份（例如密碼管理器）。**遺失就無法覆蓋更新**，使用者只能解除安裝（資料會一起刪除）。不要把它 commit 進 repo（`.gitignore` 已排除）。
> 沒有設定 secrets 時，推送到 `main` 仍會產出 debug APK；推送 `v*` 標籤則會直接失敗並提示你設定金鑰。

### 2. 發佈

```bash
# 修改 package.json 的 version（選用），然後：
git tag v0.1.0
git push origin v0.1.0
```

約 5–8 分鐘後，Releases 頁就會出現新版本，README 頂端的下載連結（releases/latest）會自動指向它。版本名稱取自標籤（`v0.1.0` → `0.1.0`），`versionCode` 取自 Actions 的執行編號，所以每次發佈都會遞增。

## 本機開發

需求：Node.js 20+、JDK 21、Android Studio（含 Android SDK）。

```bash
npm install
npm test                 # 單元測試（ID 解析、加入判斷、站方回應解析、CSV、四語鍵一致、封面下載流程）
npm run android:prepare  # 建置網頁 → 產生 android/ → 套用設定 → 同步
npm run android:open     # 用 Android Studio 開啟，接手機執行
```

- `android/` 資料夾不進版控，由 `npx cap add android` 產生後，再用 [`scripts/patch-android.mjs`](../scripts/patch-android.mjs) 套上關閉備份、禁止明文傳輸、CI 版本號與簽章等設定。
- SQLite 外掛只在 Android 上運作，`npm run dev` 在桌面瀏覽器開啟時會初始化失敗，屬正常現象；介面除錯請用實機＋`chrome://inspect`（需把 `capacitor.config.json` 的 `webContentsDebuggingEnabled` 暫時改成 `true`）。
- 第一次 `npm install` 後建議把 `package-lock.json` 一併 commit，CI 會改用 `npm ci` 鎖定外掛版本。

## 專案結構

```
.github/workflows/build-apk.yml  建置與發佈 APK
scripts/patch-android.mjs        對產生的 Android 專案套用設定
plugins/nh-webfetch/             本地 Capacitor 外掛：WebView 驗證抓取、接收分享（Java）
capacitor.config.json            App ID、名稱、外掛設定
index.html                       含 CSP
src/
  App.vue                        底部三格導覽、返回鍵、前景佇列、接收分享
  components/
    FoldersPage.vue              資料夾頁（多選模式、⋮ 單本選單）
    CoverGrid.vue                虛擬捲動封面牆（書名、⋮、選取標記）
    AddPage.vue                  新增頁（先存、後查、最近加入）
    QueueBanner.vue              背景佇列提示（429、網路、驗證、錯誤）
    bookStatus.js                書的狀態 → 佔位圖文字
    SettingsPage.vue             設定頁
    DialogHost.vue               對話框／選單／提示
  services/                      服務層（唯一碰資料庫、檔案與網路的地方）
    nhSource.js                  站方轉接層：請求、兩條節流隊伍、解析、封面下載、分享文字
    library.js                   書籍／資料夾／背景佇列／CSV／健康檢查
    db.js                        SQLite 連線與 schema 遷移
    settings.js                  設定鍵值與預設端點
    parse.js / csv.js / errors.js / addPlan.js / settingsMigration.js  純函式（可單元測試）
  locales.js                     繁中／简中／英／日字串（純資料）
  i18n.js                        t()／errText()／語言偵測
tests/                           Vitest 單元測試
```

## 用 Claude Code 維護

專案已附 [`CLAUDE.md`](../CLAUDE.md)（架構與必守規則）與 `.claude/settings.json`。環境準備、操作流程與提示詞範例見 [`docs/claude-code-guide.md`](claude-code-guide.md)。

## 安裝與更新（技術細節）

1. 用手機開啟 README 的「下載最新版 APK」連結（Releases 頁的 `nh-shelfie.apk`）。
2. 開啟下載的檔案；第一次安裝時 Android 會要求允許「安裝不明應用程式」，請對瀏覽器或檔案管理員開啟此權限。
3. Play Protect 可能顯示「未知的應用程式」警告，選「仍要安裝」。
4. **更新**：下載新版 APK 直接覆蓋安裝即可，資料會保留。所有版本都以同一把金鑰簽章；若出現「套件與現有套件衝突」，代表簽章不同，請勿解除安裝舊版（會連資料一起刪除），先到設定匯出 CSV。

系統需求：Android 6.0（API 23）以上。

