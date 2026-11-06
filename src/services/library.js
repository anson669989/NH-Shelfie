// 服務層：介面只和這裡講話；這裡是唯一碰資料庫、檔案與網路（經 nhSource）的地方。
import { ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { initDb, query, run, transaction } from './db.js'
import { AppError, E, toAppError } from './errors.js'
import { normalizeFolderName } from './parse.js'
import { buildCsv, validateCsv, CSV_MAX_BYTES } from './csv.js'
import { loadSettings, setSetting, settings } from './settings.js'
import {
  fetchDetail,
  downloadCover,
  setFetchLogger,
  setModeRecorder,
  galleryPageUrl,
  showChallenge,
  clearSession,
  getLastDetailTrace,
} from './nhSource.js'

const COVERS_DIR = 'covers'
const PREVIEW_DIR = 'preview'
const RESERVED_NAMES = new Set(['全部', '未分類', 'all', 'uncategorized', 'すべて', '未分類'])

/** 資料有變動時遞增，介面以 watch 重新查詢 */
export const dataVersion = ref(0)
export const pendingCount = ref(0)
export const queueRunning = ref(false)
const bump = () => dataVersion.value++

let dataBaseSrc = ''
let cacheBaseSrc = ''

// ================= 初始化 =================
export async function initLibrary() {
  await initDb()
  await loadSettings()
  setFetchLogger(writeFetchLog)
  setModeRecorder((mode) => setSetting('last_fetch_ok', mode))

  await Filesystem.mkdir({ path: COVERS_DIR, directory: Directory.Data, recursive: true }).catch(() => {})
  await Filesystem.writeFile({
    path: `${COVERS_DIR}/.nomedia`,
    data: '',
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  }).catch(() => {})

  dataBaseSrc = Capacitor.convertFileSrc((await Filesystem.getUri({ path: '', directory: Directory.Data })).uri)
  cacheBaseSrc = Capacitor.convertFileSrc((await Filesystem.getUri({ path: '', directory: Directory.Cache })).uri)

  await clearPreviewCache()
  await cleanupOrphanCovers().catch((e) => console.warn('orphan cleanup failed', e))
  await refreshPendingCount()
}

function joinSrc(base, path) {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}
export function coverSrc(book) {
  if (!book?.cover_path) return ''
  return joinSrc(dataBaseSrc, book.cover_path) + `?v=${book.cover_rev || 0}`
}
export function cacheSrc(path) {
  return joinSrc(cacheBaseSrc, path) + `?t=${Date.now()}`
}

async function clearPreviewCache() {
  for (const dir of [PREVIEW_DIR, 'refetch', 'test', 'export']) {
    await Filesystem.rmdir({ path: dir, directory: Directory.Cache, recursive: true }).catch(() => {})
  }
}

/** 啟動時刪除沒有對應紀錄的孤兒封面檔（儲存中 App 被關閉時會發生） */
async function cleanupOrphanCovers() {
  const { files } = await Filesystem.readdir({ path: COVERS_DIR, directory: Directory.Data })
  const rows = await query('SELECT cover_path FROM books WHERE cover_path IS NOT NULL')
  const keep = new Set(rows.map((r) => r.cover_path.split('/').pop()))
  for (const f of files) {
    const name = typeof f === 'string' ? f : f.name
    if (name === '.nomedia' || keep.has(name)) continue
    await Filesystem.deleteFile({ path: `${COVERS_DIR}/${name}`, directory: Directory.Data }).catch(() => {})
  }
}

// ================= 抓取紀錄 =================
async function writeFetchLog(e) {
  await run('INSERT INTO fetch_log(at, gallery_id, kind, http_status, error_code) VALUES (?,?,?,?,?)', [
    e.at,
    e.gallery_id ?? null,
    e.kind ?? null,
    e.http_status ?? null,
    e.error_code ?? null,
  ])
  await run(
    'DELETE FROM fetch_log WHERE id <= (SELECT id FROM fetch_log ORDER BY id DESC LIMIT 1 OFFSET 500)',
  )
}

export async function fetchLogSummary() {
  const rows = await query('SELECT error_code FROM fetch_log ORDER BY id DESC LIMIT 50')
  const ok = rows.filter((r) => !r.error_code).length
  const byCode = {}
  for (const r of rows) if (r.error_code) byCode[r.error_code] = (byCode[r.error_code] || 0) + 1
  return { total: rows.length, ok, byCode }
}

// ================= 書籍 =================
export async function getBook(id) {
  const rows = await query(
    'SELECT gallery_id, media_id, title, title_ja, cover_path, cover_ext, cover_rev, note, fetch_status, added_at FROM books WHERE gallery_id = ?',
    [id],
  )
  return rows[0] || null
}

export async function getBookFolders(id) {
  return query(
    'SELECT f.id, f.name FROM folders f JOIN book_folders bf ON bf.folder_id = f.id WHERE bf.gallery_id = ? ORDER BY f.sort_order, f.id',
    [id],
  )
}

const SORT_SQL = {
  added_desc: 'b.added_at DESC, b.gallery_id DESC',
  added_asc: 'b.added_at ASC, b.gallery_id ASC',
  id_desc: 'b.gallery_id DESC',
  id_asc: 'b.gallery_id ASC',
  title: "CASE WHEN b.title = '' THEN 1 ELSE 0 END, b.title COLLATE NOCASE ASC, b.gallery_id ASC",
}
export const SORT_MODES = Object.keys(SORT_SQL)

/**
 * 列表查詢只取顯示欄位（raw_json 在獨立的 book_raw 表）。
 * @param {'all'|'uncat'|number} folderKey
 */
export async function listBooks(folderKey, sortMode) {
  const order = SORT_SQL[sortMode] || SORT_SQL.added_desc
  const cols = 'b.gallery_id, b.title, b.cover_path, b.cover_rev, b.fetch_status'
  if (folderKey === 'all') return query(`SELECT ${cols} FROM books b ORDER BY ${order}`)
  if (folderKey === 'uncat')
    return query(
      `SELECT ${cols} FROM books b WHERE NOT EXISTS (SELECT 1 FROM book_folders bf WHERE bf.gallery_id = b.gallery_id) ORDER BY ${order}`,
    )
  return query(
    `SELECT ${cols} FROM books b JOIN book_folders bf ON bf.gallery_id = b.gallery_id WHERE bf.folder_id = ? ORDER BY ${order}`,
    [Number(folderKey)],
  )
}

/**
 * 新增頁「查詢」：取得詳情，再把封面原生下載到快取目錄供預覽。
 * 詳情失敗（404、被擋、格式不符…）直接丟錯，不存入。
 * 封面失敗則回傳 cover = null，仍可存入（灰底問號封面）。
 */
export async function lookupGallery(id) {
  if (await getBook(id)) throw new AppError(E.DUPLICATE)
  const detail = await fetchDetail(id)
  let cover = null
  try {
    const tmp = `${PREVIEW_DIR}/${id}-${Date.now()}.tmp`
    const res = await downloadCover(id, detail.meta, tmp)
    cover = { cachePath: res.path, ext: res.ext, src: cacheSrc(res.path) }
  } catch (err) {
    if (toAppError(err).code === E.RATE_LIMITED) throw err
    cover = null
  }
  return { id, ...detail, cover }
}

async function moveCacheToCovers(cachePath, id, ext) {
  const target = `${COVERS_DIR}/${id}.${ext}`
  try {
    await Filesystem.rename({ from: cachePath, to: target, directory: Directory.Cache, toDirectory: Directory.Data })
  } catch {
    try {
      await Filesystem.copy({ from: cachePath, to: target, directory: Directory.Cache, toDirectory: Directory.Data })
      await Filesystem.deleteFile({ path: cachePath, directory: Directory.Cache }).catch(() => {})
    } catch (err) {
      throw new AppError(E.STORAGE_FULL, { cause: String(err?.message || err) })
    }
  }
  return target
}

async function deleteCoverFile(path) {
  if (path) await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => {})
}

/**
 * 寫入順序：先存封面檔 → 再在一個交易內寫 books、book_raw、book_folders；
 * 寫庫失敗就刪掉封面檔，不留孤兒檔。
 */
export async function addBook(lookup, folderIds = []) {
  const id = lookup.id
  let coverPath = null
  if (lookup.cover) coverPath = await moveCacheToCovers(lookup.cover.cachePath, id, lookup.cover.ext)
  const m = lookup.meta
  const now = Math.floor(Date.now() / 1000)
  try {
    await transaction([
      {
        statement:
          'INSERT INTO books(gallery_id, media_id, title, title_ja, cover_path, cover_ext, cover_rev, note, fetch_status, added_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        values: [id, m.mediaId, m.title, m.titleJa, coverPath, lookup.cover?.ext ?? m.coverExt, 0, null, coverPath ? 'ok' : 'no_cover', now],
      },
      {
        statement: 'INSERT INTO book_raw(gallery_id, raw_json, raw_format) VALUES (?,?,?)',
        values: [id, lookup.rawJson, lookup.rawFormat],
      },
      ...folderIds.map((fid) => ({
        statement: 'INSERT OR IGNORE INTO book_folders(gallery_id, folder_id) VALUES (?,?)',
        values: [id, Number(fid)],
      })),
    ])
  } catch (err) {
    await deleteCoverFile(coverPath)
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err?.message || err))) throw new AppError(E.DUPLICATE)
    throw toAppError(err).code === E.STORAGE_FULL ? toAppError(err) : new AppError(E.DB_FAILED, { cause: String(err) })
  }
  bump()
}

export async function addBookToFolders(id, folderIds) {
  if (!folderIds.length) return
  await transaction(
    folderIds.map((fid) => ({
      statement: 'INSERT OR IGNORE INTO book_folders(gallery_id, folder_id) VALUES (?,?)',
      values: [id, Number(fid)],
    })),
  )
  bump()
}

export async function removeBookFromFolder(id, folderId) {
  await run('DELETE FROM book_folders WHERE gallery_id = ? AND folder_id = ?', [id, Number(folderId)])
  bump()
}

export async function deleteBook(id) {
  const book = await getBook(id)
  if (!book) return
  await run('DELETE FROM books WHERE gallery_id = ?', [id])
  await deleteCoverFile(book.cover_path)
  bump()
}

/** 長按「重新抓封面」 */
export async function refetchCover(id) {
  let book = await getBook(id)
  if (!book) return
  if (!book.media_id) {
    await fillDetail(book)
    book = await getBook(id)
  }
  const tmp = `refetch/${id}-${Date.now()}.tmp`
  const res = await downloadCover(id, { mediaId: book.media_id, coverExt: book.cover_ext || 'jpg' }, tmp)
  await deleteCoverFile(book.cover_path)
  const path = await moveCacheToCovers(res.path, id, res.ext)
  await run(
    "UPDATE books SET cover_path = ?, cover_ext = ?, cover_rev = cover_rev + 1, fetch_status = 'ok' WHERE gallery_id = ?",
    [path, res.ext, id],
  )
  bump()
}

async function fillDetail(book) {
  const d = await fetchDetail(book.gallery_id)
  await transaction([
    {
      statement: 'UPDATE books SET media_id = ?, title = ?, title_ja = ?, cover_ext = ? WHERE gallery_id = ?',
      values: [d.meta.mediaId, d.meta.title, d.meta.titleJa, d.meta.coverExt, book.gallery_id],
    },
    {
      statement: 'INSERT OR REPLACE INTO book_raw(gallery_id, raw_json, raw_format) VALUES (?,?,?)',
      values: [book.gallery_id, d.rawJson, d.rawFormat],
    },
  ])
}

export function openUrlFor(id) {
  return galleryPageUrl(id)
}

// ================= 資料夾 =================
export async function listFolders() {
  return query('SELECT id, name, sort_order, sort_mode FROM folders ORDER BY sort_order, id')
}

async function validateFolderName(name, exceptId = null) {
  const n = normalizeFolderName(name)
  if (!n || RESERVED_NAMES.has(n.toLowerCase())) throw new AppError(E.FOLDER_NAME_INVALID)
  const dup = await query('SELECT id FROM folders WHERE name = ? AND id IS NOT ?', [n, exceptId])
  if (dup.length) throw new AppError(E.FOLDER_NAME_DUP)
  return n
}

export async function createFolder(name) {
  const n = await validateFolderName(name)
  const max = (await query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM folders'))[0].m
  const res = await run('INSERT INTO folders(name, sort_order, sort_mode, created_at) VALUES (?,?,?,?)', [
    n,
    Number(max) + 1,
    'added_desc',
    Math.floor(Date.now() / 1000),
  ])
  bump()
  return res.lastId
}

export async function renameFolder(id, name) {
  const n = await validateFolderName(name, Number(id))
  await run('UPDATE folders SET name = ? WHERE id = ?', [n, Number(id)])
  bump()
}

/** 刪除資料夾只刪關聯、不刪書 */
export async function deleteFolder(id) {
  await transaction([
    { statement: 'DELETE FROM book_folders WHERE folder_id = ?', values: [Number(id)] },
    { statement: 'DELETE FROM folders WHERE id = ?', values: [Number(id)] },
  ])
  bump()
}

/** dir = -1 往上、+1 往下 */
export async function moveFolder(id, dir) {
  const list = await listFolders()
  const i = list.findIndex((f) => f.id === Number(id))
  const j = i + dir
  if (i < 0 || j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
  await transaction(
    list.map((f, idx) => ({ statement: 'UPDATE folders SET sort_order = ? WHERE id = ?', values: [idx + 1, f.id] })),
  )
  bump()
}

export async function getSortMode(folderKey) {
  if (folderKey === 'all') return settings.sort_all
  if (folderKey === 'uncat') return settings.sort_uncat
  const r = await query('SELECT sort_mode FROM folders WHERE id = ?', [Number(folderKey)])
  return r[0]?.sort_mode || 'added_desc'
}

export async function setSortMode(folderKey, mode) {
  if (!SORT_MODES.includes(mode)) return
  if (folderKey === 'all') await setSetting('sort_all', mode)
  else if (folderKey === 'uncat') await setSetting('sort_uncat', mode)
  else await run('UPDATE folders SET sort_mode = ? WHERE id = ?', [mode, Number(folderKey)])
}

/** 各資料夾本數：{ all, uncat, byFolder: { [folderId]: n } } */
export async function folderCounts() {
  const all = (await query('SELECT COUNT(*) AS n FROM books'))[0].n
  const uncat = (
    await query(
      'SELECT COUNT(*) AS n FROM books b WHERE NOT EXISTS (SELECT 1 FROM book_folders bf WHERE bf.gallery_id = b.gallery_id)',
    )
  )[0].n
  const byFolder = {}
  for (const r of await query('SELECT folder_id, COUNT(*) AS n FROM book_folders GROUP BY folder_id')) {
    byFolder[r.folder_id] = r.n
  }
  return { all, uncat, byFolder }
}

// ================= 待抓佇列（只在前景執行） =================
export async function refreshPendingCount() {
  pendingCount.value = (await query("SELECT COUNT(*) AS n FROM books WHERE fetch_status = 'pending'"))[0].n
}

let stopRequested = false
export function stopQueue() {
  stopRequested = true
}

/** 依序處理 pending 的書；遇到離線、被擋、限速就停下，回到前景再續跑。 */
export async function runQueue() {
  if (queueRunning.value) return
  queueRunning.value = true
  stopRequested = false
  try {
    while (!stopRequested) {
      const book = (
        await query(
          "SELECT gallery_id, media_id, cover_ext, cover_path FROM books WHERE fetch_status = 'pending' ORDER BY added_at, gallery_id LIMIT 1",
        )
      )[0]
      if (!book) break
      try {
        if (!book.media_id) await fillDetail(book)
        const fresh = await getBook(book.gallery_id)
        try {
          const res = await downloadCover(
            book.gallery_id,
            { mediaId: fresh.media_id, coverExt: fresh.cover_ext || 'jpg' },
            `refetch/${book.gallery_id}-${Date.now()}.tmp`,
          )
          await deleteCoverFile(fresh.cover_path)
          const path = await moveCacheToCovers(res.path, book.gallery_id, res.ext)
          await run(
            "UPDATE books SET cover_path = ?, cover_ext = ?, cover_rev = cover_rev + 1, fetch_status = 'ok' WHERE gallery_id = ?",
            [path, res.ext, book.gallery_id],
          )
        } catch (err) {
          const code = toAppError(err).code
          if (code === E.RATE_LIMITED) throw err
          await run("UPDATE books SET fetch_status = 'no_cover' WHERE gallery_id = ?", [book.gallery_id])
        }
      } catch (err) {
        const code = toAppError(err).code
        if ([E.OFFLINE, E.TIMEOUT, E.BLOCKED, E.CHALLENGE, E.RATE_LIMITED, E.STORAGE_FULL].includes(code)) {
          throw err
        }
        // 查無此書 / 格式不符：不再重試，標為 no_cover（長按可手動重抓）
        await run("UPDATE books SET fetch_status = 'no_cover' WHERE gallery_id = ?", [book.gallery_id])
      }
      await refreshPendingCount()
      bump()
    }
  } finally {
    queueRunning.value = false
    await refreshPendingCount()
  }
}

/** 設定頁「重抓所有缺少的封面」：把沒有封面或封面檔不見的書標成 pending */
export async function markMissingCoversPending() {
  const { files } = await Filesystem.readdir({ path: COVERS_DIR, directory: Directory.Data }).catch(() => ({
    files: [],
  }))
  const present = new Set(files.map((f) => (typeof f === 'string' ? f : f.name)))
  const rows = await query('SELECT gallery_id, cover_path, fetch_status FROM books')
  const ids = rows
    .filter((r) => r.fetch_status !== 'pending')
    .filter((r) => !r.cover_path || !present.has(r.cover_path.split('/').pop()))
    .map((r) => r.gallery_id)
  if (ids.length) {
    await transaction(
      ids.map((id) => ({ statement: "UPDATE books SET fetch_status = 'pending' WHERE gallery_id = ?", values: [id] })),
    )
  }
  await refreshPendingCount()
  bump()
  return ids.length
}

// ================= Cloudflare 驗證 =================
/**
 * 顯示驗證畫面讓使用者手動通過 Cloudflare challenge。
 * @param {{title:string, closeLabel:string}} labels 由介面以 t() 提供
 * @returns {Promise<boolean>} 是否通過
 */
export async function verifyChallenge(labels) {
  return showChallenge(labels)
}

/** 設定頁「重設驗證」：清除 nhentai 的 cookie，auto 模式重新從原生請求試起 */
export async function resetVerification() {
  await clearSession()
  await setSetting('last_fetch_ok', '')
}

// ================= 健康檢查 =================
export async function testConnection() {
  const id = Number.parseInt(settings.test_id, 10) || 177013
  const result = { detail: null, cover: null, diagnostics: null }
  let coverDiag = null
  try {
    const d = await fetchDetail(id)
    result.detail = 'ok'
    try {
      const res = await downloadCover(id, d.meta, `test/${id}.tmp`)
      result.cover = 'ok'
      coverDiag = { result: 'ok', mediaId: d.meta.mediaId, ext: d.meta.coverExt }
      await Filesystem.deleteFile({ path: res.path, directory: Directory.Cache }).catch(() => {})
    } catch (err) {
      const e = toAppError(err)
      result.cover = e.cause || e.code
      coverDiag = { result: e.code, cause: e.cause ?? null, mediaId: d.meta.mediaId, ext: d.meta.coverExt }
    }
  } catch (err) {
    result.detail = toAppError(err).code
  }
  // 開發者模式顯示用；只存在這次回傳值，不寫入資料庫
  result.diagnostics = JSON.stringify(
    { app: Capacitor.getPlatform(), testId: id, detail: getLastDetailTrace(), cover: coverDiag },
    null,
    2,
  )
  return result
}

// ================= 儲存空間 =================
export async function coversSize() {
  const { files } = await Filesystem.readdir({ path: COVERS_DIR, directory: Directory.Data }).catch(() => ({
    files: [],
  }))
  let bytes = 0
  for (const f of files) if (typeof f !== 'string' && f.size) bytes += Number(f.size)
  return { count: files.filter((f) => (typeof f === 'string' ? f : f.name) !== '.nomedia').length, bytes }
}

export async function clearTempCache() {
  await clearPreviewCache()
}

// ================= CSV =================
export async function exportCsv() {
  const rows = await query(
    "SELECT b.gallery_id, b.note, b.added_at, (SELECT group_concat(f.name, char(31)) FROM book_folders bf JOIN folders f ON f.id = bf.folder_id WHERE bf.gallery_id = b.gallery_id) AS folder_names FROM books b ORDER BY b.added_at, b.gallery_id",
  )
  const csv = buildCsv(
    rows.map((r) => ({
      gallery_id: r.gallery_id,
      note: r.note,
      added_at: r.added_at,
      folders: r.folder_names ? String(r.folder_names).split('\u001f') : [],
    })),
  )
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const path = `export/nh-shelfie-${stamp}.csv`
  const { uri } = await Filesystem.writeFile({
    path,
    data: csv,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    recursive: true,
  })
  await Share.share({ title: 'nh-shelfie.csv', files: [uri] })
  await setSetting('last_export_at', String(Math.floor(Date.now() / 1000)))
  return rows.length
}

/** 讀取並驗證 CSV，回傳預覽（將新增 N 筆、跳過 M 筆與原因），尚未寫入。 */
export async function previewCsvImport(file) {
  if (file.size > CSV_MAX_BYTES) throw new AppError(E.CSV_INVALID, { reason: 'too_large' })
  const buf = await file.arrayBuffer()
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    throw new AppError(E.CSV_INVALID, { reason: 'encoding' })
  }
  const existing = new Set((await query('SELECT gallery_id FROM books')).map((r) => r.gallery_id))
  const res = validateCsv(text, existing)
  if (!res.headerOk) throw new AppError(E.CSV_INVALID, { reason: 'header' })
  return res
}

/** 匯入：缺少的資料夾自動建立 → 新書以 pending 狀態存入 → 封面由佇列慢慢抓 */
export async function commitCsvImport(okRows) {
  const existingFolders = new Set((await listFolders()).map((f) => f.name))
  let order = Number((await query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM folders'))[0].m)
  const now = Math.floor(Date.now() / 1000)
  const set = []
  for (const r of okRows) {
    for (const name of r.folders) {
      if (!existingFolders.has(name)) {
        existingFolders.add(name)
        set.push({
          statement: 'INSERT OR IGNORE INTO folders(name, sort_order, sort_mode, created_at) VALUES (?,?,?,?)',
          values: [name, ++order, 'added_desc', now],
        })
      }
    }
  }
  for (const r of okRows) {
    set.push({
      statement:
        "INSERT OR IGNORE INTO books(gallery_id, title, title_ja, note, fetch_status, added_at) VALUES (?, '', '', ?, 'pending', ?)",
      values: [r.gallery_id, r.note || null, r.added_at],
    })
    for (const name of r.folders) {
      set.push({
        statement:
          'INSERT OR IGNORE INTO book_folders(gallery_id, folder_id) SELECT ?, id FROM folders WHERE name = ?',
        values: [r.gallery_id, name],
      })
    }
  }
  await transaction(set)
  await refreshPendingCount()
  bump()
}

export { setSetting, settings }
