# 任務 005：封面修正、介面小修、文件整理（批次）

> 目標版本：v0.1.1（CI 版本名 `0.1.1-dev.<建置編號>`）　·　建立：2026-11-06　·　前置：任務 004
> 狀態：**程式完成，待實機驗收**（第 4 節）

## 1. 背景

dev.10「測試連線」診斷：詳情 ✓；封面 t1–t4 四台的 HEAD 都是 `200 image/jpeg 110179`，但下載全部失敗：

```
Error downloading file: /data/user/0/io.github.anson669989.nhshelfie/cache/test/228922.tmp: open failed: ENOENT (No such file or directory)
```

→ `Filesystem.downloadFile` 不會自己建立上層資料夾；舊程式又把這個寫檔錯誤顯示成「目前離線」。

## 2. 使用者決定

- B2「清除封面快取」只清暫存資料夾（`preview/`、`refetch/`、`test/`、`export/`）並顯示大小；收藏的封面不刪；舊的「清除暫存檔」按鈕併進來。
- B5 版本維持 `0.1.1`，保留 CI 的 `-dev.<建置編號>` 後綴，不改 workflow。
- 同意修改 `CLAUDE.md` 與 `.claude/settings.json`。

## 3. 項目與結果

### A. 封面與連線（commit `d445d00`）

| # | 項目 | 結果 | 檔案 |
| --- | --- | --- | --- |
| A1 | 下載前建立資料夾 | `ensureParentDir()`：每次下載封面前 `Filesystem.mkdir(recursive)`，「已存在」錯誤略過；搬進收藏前也先建 `covers/` | `nhSource.js`、`library.js` |
| A2 | 寫檔失敗 ≠ 離線 | 新錯誤碼 `WRITE_FAILED`（三語）；`classifyDownloadError()` 依訊息分類：ENOENT／EACCES／open failed → `WRITE_FAILED`，ENOSPC → `STORAGE_FULL`，只有系統回報離線或連線類訊息才是 `OFFLINE`，認不出來的是 `COVER_FAILED` | `parse.js`、`errors.js`、`i18n.js` |
| A3 | 主機順序與記憶 | `orderServers()`：上次成功的主機（新設定鍵 `cdn_last_host`）優先，其餘照 `/api/v2/cdn` 順序 t1→t2→t3→t4；主機相關失敗才換下一台，間隔 ≥ 3 秒；寫檔失敗／空間不足／429 不換主機直接停 | `parse.js`、`nhSource.js`、`settings.js` |
| A4 | 預設 ID 228922 | 已是預設；遷移規則抽到純函式 `planSettingsMigration()`，存的值是 177013 會自動換成 228922 | `settingsMigration.js`、`settings.js` |
| A5 | 單元測試 | `tests/cover-download.test.js`（dev.10 訊息 → `WRITE_FAILED`、主機順序、設定遷移）、`tests/download-flow.test.js`（以假檔案系統跑 `downloadCover`：資料夾不存在、已存在、建資料夾失敗、寫檔失敗、t1/t2 失敗換 t3 並記住、四台全失敗、3 秒間隔） | `tests/` |
| A6 | 加入流程檢查 | 修了 5 個問題，見下 | `nhSource.js`、`library.js` |

A6 檢查「輸入 ID → 詳情 → 下載封面 → 寫入資料庫 → 收藏頁顯示」發現並修正 5 個問題：

1. 預覽、重抓、測試三個暫存資料夾在啟動時會被清掉，之後下載就因資料夾不存在而失敗（即本次主因）→ A1。
2. 下載逾時後，背景仍在寫的檔案可能蓋到下一台主機的結果 → 每次嘗試寫到各自的暫存檔（`xxx.tmp.0`、`.1`…）。
3. 重抓封面時先刪舊檔再搬新檔，搬檔失敗會讓資料庫指向不存在的檔案 → 新封面先存成新檔名、更新資料庫，成功後才刪舊檔。
4. CSV 補抓佇列遇到寫檔失敗會把整批書標成「無封面」→ 寫檔／空間／離線類錯誤改成停下佇列，修好後可繼續。
5. 預覽時封面失敗的原因被吞掉 → `lookupGallery` 回傳 `coverError`，新增頁顯示原因（B1）。

不需要 schema 遷移（資料表未變動）；新增設定鍵 `cdn_last_host`。

### B. 介面（commit `5beb973`）

| # | 項目 | 結果 |
| --- | --- | --- |
| B1 | 白話錯誤訊息 | 三語 `err.*` 全部改成「發生什麼＋下一步」；新增頁封面失敗時顯示原因，並說明仍可加入、之後長按重抓 |
| B2 | 清除封面快取 | 設定頁顯示暫存檔案數與大小，按鈕只清 `preview/`、`refetch/`、`test/`、`export/` |
| B3 | 診斷只在開發者模式 | 確認維持（關於 → 版本 連點 7 次） |
| B4 | 原創圖示 | 紅底（`#ed2553`）白色書本、粉色書背、深紅書籤；`scripts/gen-icons.mjs` 只用 Node 內建模組產生傳統／圓形／自適應圖示，`patch-android.mjs` 每次建置自動套用；`tests/icons.test.js` 驗證 |
| B5 | 版本 0.1.1 | `package.json` 已是 0.1.1，未改 |

### C. 文件與設定（本 commit）

- C1 `CLAUDE.md` 最上方「回報方式」（使用者先加，補一條手機測試步驟）。
- C2 `.claude/settings.json` deny：`Read(./package-lock.json)`、`Read(./node_modules/**)`、`Read(./dist/**)`（整理縮排）。
- C3 `CLAUDE.md`：新增 API v2 規則段落、規則 12（寫檔前建資料夾）；待辦移除已解決的 001、004；003 的 3.2–3.4 改為暫緩；002 標為待驗收。
- C4 README：「資料來源：nhentai API v2」與「已知限制」。
- C5 `004-api-v2.md` 標記完成並寫結果；本檔。

## 4. 實機驗收（待做）

- [ ] 設定 → 進階 → 測試連線：詳情 ✓、封面 ✓（開發者模式下診斷的 `cover.attempts[0].ok` 為 true）
- [ ] 新增一本（例 228922）：預覽出現封面與書名 → 加入收藏 → 資料夾頁顯示封面 → 點封面開網頁
- [ ] 長按封面 → 重抓封面：封面仍正常顯示
- [ ] 設定頁「清除封面快取」：顯示大小，清除後變 0，收藏的封面仍在
- [ ] 桌面圖示是紅底白書
- [ ] 關掉網路再查詢：顯示「網路連不上…」，不是錯誤代碼
