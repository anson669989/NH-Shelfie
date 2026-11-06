# 用 Claude Code 維護本專案

## 1. 環境準備（只做一次）

| 項目 | 說明 |
| --- | --- |
| Claude 帳號 | Pro / Max 訂閱，或 Anthropic API 金鑰 |
| Node.js 20+ | `node -v` 確認 |
| Git | 並已登入 GitHub（`git push` 可用） |
| Claude Code | 見下方安裝 |
| JDK 21 + Android Studio | 選用；只有要在本機建置 / 實機除錯才需要，平常交給 GitHub Actions 建 APK |

安裝 Claude Code（擇一，細節以官方文件為準）：

```bash
# macOS / Linux / WSL 原生安裝
curl -fsSL https://claude.ai/install.sh | bash

# 或用 npm
npm install -g @anthropic-ai/claude-code
```

第一次執行 `claude` 會要求登入。

## 2. 取得專案

```bash
git clone https://github.com/anson669989/NH-Shelfie.git
cd NH-Shelfie
npm install
npm test        # 確認基準是綠的
claude          # 在專案根目錄啟動
```

專案已附：

- `CLAUDE.md`：架構、必守規則、指令，Claude Code 每次啟動都會自動讀取，所以不必重複交代背景
- `.claude/settings.json`：預先允許 `npm test`、`npm run build` 等安全指令，避免一直詢問；禁止讀取金鑰檔、禁止強制推送

## 3. 日常操作流程

```
開新 session → 描述單一任務 → 看計畫 → 同意修改 → 跑測試 → commit / push → 看 Actions
```

1. **一個任務一個 session。** 做完用 `/clear` 清空，或直接開新視窗，不要讓不相關的歷史一直累積。
2. **先計畫再動手。** 按 `Shift+Tab` 切到 Plan Mode，讓它先列出要改的檔案與做法；確認後再切回一般模式執行。
3. **指定範圍。** 寫出要改的檔案或模組，例如「只改 `src/components/AddPage.vue` 與 `src/i18n.js`」。
4. **每次改完要求它跑 `npm test` 與 `npm run build`**，失敗讓它自己修。
5. **用 git 當存檔點。** 每完成一小步就 commit，改壞了可以 `git restore` 退回。

```bash
git switch -c feat/detail-page      # 一個功能一個分支
# …在 Claude Code 裡完成修改…
git push -u origin feat/detail-page # push 會觸發 Actions 建 debug APK 供測試
```

6. **測試 APK：** 到 GitHub → Actions → 最新一次執行 → Artifacts 下載 APK 安裝。
7. **正式發佈：** 合併到 main 後打標籤 `git tag v0.2.0 && git push origin v0.2.0`。

## 4. 常用指令

| 指令 | 用途 |
| --- | --- |
| `/clear` | 清空對話，開始下一個任務（最能省 token） |
| `/compact` | 對話太長時壓縮成摘要，保留重點 |
| `/context` | 查看目前上下文用量 |
| `/cost` 或 `/usage` | 查看用量 |
| `/model` | 切換模型：日常小改用較小的模型，複雜設計再用較強的 |
| `/resume`、`claude -c` | 接續上一個 session |
| `/init` | 重新產生 CLAUDE.md（本專案已有，通常不需要） |
| `Esc` | 中斷目前動作；`Esc` 兩下可回溯到先前的對話點 |
| `#` 開頭輸入 | 把一條規則追加到 CLAUDE.md 記憶 |

## 5. 省 token 守則

- 任務描述寫清楚「改哪個檔案、要什麼行為、驗收方式」，避免它漫無目的地搜尋
- 不要貼整個檔案給它，給路徑就好
- 要求「只改必要處、不要整檔重寫」
- 新功能分里程碑做（M4、M5 各一個 session）
- 看到上下文快滿（`/context`）就先 commit，再 `/clear`
- 大範圍檢視（例如「檢查所有地方是否符合安全規則」）放在獨立 session，不要混在功能開發裡

## 6. 範例提示詞

**M4 詳情頁**

```
實作 M4 詳情頁。需求：
- 點封面改為開詳情頁（標籤、個人備註、「在瀏覽器開啟」按鈕）
- 設定頁新增「點擊直接開網頁」選項，開啟時維持現狀行為
- 標籤從 book_raw.raw_json 本地解析，不新增網路請求
- 備註寫入 books.note，純文字顯示
- 新增字串三種語言都補
先用 Plan Mode 列出要改的檔案，我確認後再動手。完成後跑 npm test 與 npm run build。
```

**M5 標籤搜尋**

```
實作 M5 路線 B。在 db.js 的 MIGRATIONS 新增 v2：tags、book_tags 與索引，
遷移時從 book_raw 回填。資料夾頁加標籤篩選。
raw_format 為 api-v1 的才解析；解析器放 parse.js 並補單元測試。
```

**站方改版時**

```
nhentai 的詳情 API 回應格式變了，這是新的回應內容：<貼上一份 JSON>
只修改 src/services/parse.js 的 parseGallery 與對應測試，
並新增 raw_format 版本 api-v2，保持 api-v1 仍可解析。
```

**除錯**

```
Actions 的 Build Android APK 失敗，錯誤如下：<貼上最後 50 行>
找出原因並修正，只改必要的檔案。
```

## 7. 疑難排解

| 狀況 | 處理 |
| --- | --- |
| Actions 在 Gradle 步驟失敗 | 把錯誤最後 50 行貼給 Claude Code；常見是外掛版本與 Capacitor 主版本不一致 |
| 發佈標籤後 Actions 報「需要簽章金鑰」 | 依 README 設定四個 Secrets |
| `npm run dev` 初始化失敗 | 正常，SQLite 外掛只在 Android 運作；請用實機或 Actions 的 APK 測試 |
| 覆蓋安裝出現「套件衝突」 | 簽章金鑰不同；先在舊版匯出 CSV 再處理，不要直接解除安裝 |
| 想在手機上看 WebView 日誌 | 暫時把 `capacitor.config.json` 的 `webContentsDebuggingEnabled` 改 `true`，用 Chrome 開 `chrome://inspect`，除錯完改回 `false` |

## 8. 安全提醒

- 不要把 `release.jks`、密碼、`keystore.properties` 放進 repo 或貼給任何 AI；`.gitignore` 與 `.claude/settings.json` 已設定擋掉
- 金鑰與密碼另外備份；遺失就無法覆蓋更新
- 要讓 Claude Code 執行 `git push` 或打標籤前，先確認分支與內容
