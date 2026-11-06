// 服務層：介面只和這裡講話；這裡是唯一碰資料庫、檔案與網路（經 nhSource）的地方。
import { reactive, ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { initDb, query, run, transaction } from './db.js'
import { AppError, E, toAppError } from './errors.js'
import { classifyDownloadError, extractGalleryId, normalizeFolderName, parseGallery } from './parse.js'
import { planAdd } from './addPlan.js'
import { buildCsv, validateCsv, CSV_MAX_BYTES } from './csv.js'
import { loadSettings, migrateSettings, setSetting, settings } from './settings.js'
import {
  RAW_FORMAT,
  fetchDetail,
  downloadCover,
  setFetchLogger,
  setSettingWriter,
  galleryPageUrl,
  showChallenge,
  clearSession,
  getLastDetailTrace,
  getLastCoverTrace,
  takeSharedText,
  onShareReceived,
} from './nhSource.js'

const COVERS_DIR = 'covers'
const PREVIEW_DIR = 'preview'
const RESERVED_NAMES = new Set(['全部', '未分類', 'all', 'uncategorized', 'すべて', '未分類'])

/** 資料有變動時遞增，介面以 watch 重新查詢 */
export const dataVersion = ref(0)
export const pendingCount = ref(0)
export const queueRunning = ref(false)
/**
 * 背景佇列狀態（介面顯示提示用）：
 * apiWaitUntil／imgWaitUntil：因 429 暫停到何時（毫秒）；netWaitUntil：網路失敗，稍後自動重試；
 * challenge：需要使用者完成網站驗證；error：需要使用者處理的錯誤碼（寫檔失敗、空間不足…）
 */
export const queueState = reactive({ apiWaitUntil: 0, imgWaitUntil: 0, netWaitUntil: 0, challenge: false, error: null })
/** 從瀏覽器分享進來的內容：{ id: number|null, at }；id 為 null 代表內容裡找不到 ID */
export const sharedInput = ref(null)
const bump = () => dataVersion.value++

let dataBaseSrc = ''
let cacheBaseSrc = ''

// ================= 初始化 =================
export async function initLibrary() {
  await initDb()
  await loadSettings()
  await migrateSettings()
  setFetchLogger(writeFetchLog)
  setSettingWriter(setSetting)

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
  for (const dir of TEMP_DIRS) {
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
  added_desc: 'b.added_at DESC, COALESCE(b.queue_seq, 0) DESC, b.gallery_id DESC',
  added_asc: 'b.added_at ASC, COALESCE(b.queue_seq, 0) ASC, b.gallery_id ASC',
  id_desc: 'b.gallery_id DESC',
  id_asc: 'b.gallery_id ASC',
  title: "CASE WHEN b.title = '' THEN 1 ELSE 0 END, b.title COLLATE NOCASE ASC, b.gallery_id ASC",
}
export const SORT_MODES = Object.keys(SORT_SQL)

const LIST_COLS = 'b.gallery_id, b.title, b.cover_path, b.cover_rev, b.fetch_status'

/**
 * 列表查詢只取顯示欄位（raw_json 在獨立的 book_raw 表）。
 * @param {'all'|'uncat'|number} folderKey
 */
export async function listBooks(folderKey, sortMode) {
  const order = SORT_SQL[sortMode] || SORT_SQL.added_desc
  if (folderKey === 'all') return query(`SELECT ${LIST_COLS} FROM books b ORDER BY ${order}`)
  if (folderKey === 'uncat')
    return query(
      `SELECT ${LIST_COLS} FROM books b WHERE NOT EXISTS (SELECT 1 FROM book_folders bf WHERE bf.gallery_id = b.gallery_id) ORDER BY ${order}`,
    )
  return query(
    `SELECT ${LIST_COLS} FROM books b JOIN book_folders bf ON bf.gallery_id = b.gallery_id WHERE bf.folder_id = ? ORDER BY ${order}`,
    [Number(folderKey)],
  )
}

/** 加入頁「最近加入」：只取顯示欄位 */
export async function listRecentBooks(limit = 20) {
  return query(`SELECT ${LIST_COLS} FROM books b ORDER BY ${SORT_SQL.added_desc} LIMIT ?`, [
    Math.max(1, Math.min(100, Math.trunc(limit))),
  ])
}

/** 背景佇列的排隊順序：毫秒時間，保證遞增 */
let lastSeq = 0
function nextSeq() {
  lastSeq = Math.max(Date.now(), lastSeq + 1)
  return lastSeq
}

function checkId(id) {
  const n = Math.trunc(Number(id))
  if (!Number.isSafeInteger(n) || n <= 0 || n > 9_999_999) throw new AppError(E.INVALID_ID)
  return n
}

/**
 * 「先存、後查」：按「加入」只做本機動作，不發任何網路請求。
 * - already：已在所選資料夾 → 不做事
 * - addFolders：已收藏 → 只補資料夾關聯，不重抓資料與封面
 * - new：寫入一筆「待補資料」（meta_pending），交給背景佇列；書是否存在於網站由佇列判斷
 * @returns {Promise<{kind:'new'|'already'|'addFolders', id:number, originalFolders?:string[]}>}
 */
export async function quickAdd(id, folderIds = []) {
  id = checkId(id)
  const existing = await getBook(id)
  const existingFolders = existing ? await getBookFolders(id) : []
  const plan = planAdd(existing ? { folderIds: existingFolders.map((f) => f.id) } : null, folderIds)
  if (plan.kind === 'already') return { kind: 'already', id }
  if (plan.kind === 'addFolders') {
    await addBooksToFolders([id], plan.toAdd)
    return { kind: 'addFolders', id, originalFolders: existingFolders.map((f) => f.name) }
  }
  try {
    await transaction([
      {
        statement:
          "INSERT INTO books(gallery_id, title, title_ja, fetch_status, added_at, queue_seq) VALUES (?, '', '', 'meta_pending', ?, ?)",
        values: [id, Math.floor(Date.now() / 1000), nextSeq()],
      },
      ...folderStatements([id], plan.folderIds),
    ])
  } catch (err) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err?.message || err))) throw new AppError(E.DUPLICATE)
    throw dbError(err)
  }
  bump()
  await refreshPendingCount()
  kick('meta')
  return { kind: 'new', id }
}

/** 資料夾關聯寫入語句；已刪除的資料夾自動略過（只插入仍存在的 folder id） */
function folderStatements(ids, folderIds) {
  const out = []
  for (const id of ids) {
    for (const fid of folderIds) {
      out.push({
        statement: 'INSERT OR IGNORE INTO book_folders(gallery_id, folder_id) SELECT ?, id FROM folders WHERE id = ?',
        values: [Number(id), Number(fid)],
      })
    }
  }
  return out
}

function dbError(err) {
  const e = toAppError(err)
  return e.code === E.STORAGE_FULL ? e : new AppError(E.DB_FAILED, { cause: String(err) })
}

/** 建立收藏封面資料夾（已存在就略過）。 */
async function ensureCoversDir() {
  try {
    await Filesystem.mkdir({ path: COVERS_DIR, directory: Directory.Data, recursive: true })
  } catch (err) {
    const msg = String(err?.message || err || '')
    if (!/exist/i.test(msg)) throw fileError(err)
  }
}

/** 檔案操作錯誤 → STORAGE_FULL 或 WRITE_FAILED（不會變成 OFFLINE） */
function fileError(err) {
  const msg = String(err?.message || err || '')
  return new AppError(classifyDownloadError(err) === E.STORAGE_FULL ? E.STORAGE_FULL : E.WRITE_FAILED, { cause: msg })
}

/**
 * 把快取中的封面搬進 covers/（寫到新檔名），任何一步失敗都不會讓資料庫指向不存在的檔案。
 */
async function moveCacheToCovers(cachePath, id, ext, suffix = '') {
  await ensureCoversDir()
  const target = `${COVERS_DIR}/${id}${suffix}.${ext}`
  try {
    await Filesystem.rename({ from: cachePath, to: target, directory: Directory.Cache, toDirectory: Directory.Data })
  } catch {
    try {
      await Filesystem.copy({ from: cachePath, to: target, directory: Directory.Cache, toDirectory: Directory.Data })
      await Filesystem.deleteFile({ path: cachePath, directory: Directory.Cache }).catch(() => {})
    } catch (err) {
      await Filesystem.deleteFile({ path: cachePath, directory: Directory.Cache }).catch(() => {})
      throw fileError(err)
    }
  }
  return target
}

/** 封面下載成功後：搬到新檔名 → 更新資料庫 → 刪舊檔。書在下載途中被刪掉時，刪掉新檔。 */
async function replaceCover(id, res) {
  const path = await moveCacheToCovers(res.path, id, res.ext, `-r${Date.now()}`)
  let changes = 0
  let oldPath = null
  try {
    oldPath = (await getBook(id))?.cover_path ?? null
    const r = await run(
      "UPDATE books SET cover_path = ?, cover_ext = ?, cover_rev = cover_rev + 1, fetch_status = 'ok' WHERE gallery_id = ?",
      [path, res.ext, id],
    )
    changes = Number(r?.changes ?? 1)
  } catch (err) {
    await deleteCoverFile(path)
    throw dbError(err)
  }
  if (!changes) return deleteCoverFile(path)
  if (oldPath && oldPath !== path) await deleteCoverFile(oldPath)
}

async function deleteCoverFile(path) {
  if (path) await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => {})
}

/** 批次加入資料夾（只加不移） */
export async function addBooksToFolders(ids, folderIds) {
  if (!ids.length || !folderIds.length) return
  await transaction(folderStatements(ids, folderIds))
  bump()
}

/** 單本的資料夾關聯：勾選結果直接套用（⋮ → 分類） */
export async function setBookFolders(id, folderIds) {
  await transaction([
    { statement: 'DELETE FROM book_folders WHERE gallery_id = ?', values: [Number(id)] },
    ...folderStatements([id], folderIds),
  ])
  bump()
}

export async function removeBooksFromFolder(ids, folderId) {
  if (!ids.length) return
  await transaction(
    ids.map((id) => ({
      statement: 'DELETE FROM book_folders WHERE gallery_id = ? AND folder_id = ?',
      values: [Number(id), Number(folderId)],
    })),
  )
  bump()
}

/** 批次刪除：單一交易刪資料（book_raw、book_folders 隨 books 串聯刪除），成功後刪封面檔 */
export async function deleteBooks(ids) {
  if (!ids.length) return
  const paths = []
  for (const id of ids) {
    const b = await getBook(id)
    if (b?.cover_path) paths.push(b.cover_path)
  }
  await transaction(ids.map((id) => ({ statement: 'DELETE FROM books WHERE gallery_id = ?', values: [Number(id)] })))
  for (const p of paths) await deleteCoverFile(p)
  bump()
  await refreshPendingCount()
}

/** ⋮ 選單標題：完整英文／日文標題（單本讀 book_raw，本機解析，不上網） */
export async function getBookTitles(id) {
  const book = await getBook(id)
  const out = { pretty: book?.title || '', english: '', japanese: book?.title_ja || '' }
  const raw = (await query('SELECT raw_json, raw_format FROM book_raw WHERE gallery_id = ?', [Number(id)]))[0]
  if (raw) {
    try {
      const m = parseGallery(JSON.parse(raw.raw_json), raw.raw_format)
      out.english = m.titleEn
      out.japanese = m.titleJa || out.japanese
    } catch {
      /* 解析失敗就只顯示簡短標題 */
    }
  }
  return out
}

/**
 * 「修改 ID」（找不到這本時用）：以新 ID 重建一筆待補資料，保留資料夾、備註與加入時間，舊的刪除。
 * 新 ID 已收藏 → DUPLICATE。
 */
export async function changeBookId(oldId, newId) {
  oldId = Number(oldId)
  newId = checkId(newId)
  if (newId === oldId) return
  const old = await getBook(oldId)
  if (!old) return
  if (await getBook(newId)) throw new AppError(E.DUPLICATE)
  try {
    await transaction([
      {
        statement:
          "INSERT INTO books(gallery_id, title, title_ja, note, fetch_status, added_at, queue_seq) VALUES (?, '', '', ?, 'meta_pending', ?, ?)",
        values: [newId, old.note ?? null, old.added_at, nextSeq()],
      },
      { statement: 'UPDATE book_folders SET gallery_id = ? WHERE gallery_id = ?', values: [newId, oldId] },
      { statement: 'DELETE FROM books WHERE gallery_id = ?', values: [oldId] },
    ])
  } catch (err) {
    throw dbError(err)
  }
  await deleteCoverFile(old.cover_path)
  bump()
  await refreshPendingCount()
  kick('meta')
}

/**
 * ⋮「重抓封面」：重新排進背景佇列（不等網路）。已有 api-v2 原始資料就只抓封面，否則先補資料。
 * 舊封面保留到新封面下載成功為止。
 */
export async function requeueBook(id) {
  await run(
    `UPDATE books SET queue_seq = ?, fetch_status = CASE
        WHEN EXISTS (SELECT 1 FROM book_raw r WHERE r.gallery_id = books.gallery_id AND r.raw_format = ?) THEN 'cover_pending'
        ELSE 'meta_pending' END
      WHERE gallery_id = ?`,
    [nextSeq(), RAW_FORMAT, Number(id)],
  )
  bump()
  await refreshPendingCount()
  runQueue()
}

/** 本機的 api-v2 原始資料 → 下載封面所需的 meta；沒有或壞了回傳 null（要先補資料） */
async function localCoverMeta(id) {
  const raw = (await query('SELECT raw_json, raw_format FROM book_raw WHERE gallery_id = ?', [id]))[0]
  if (raw?.raw_format !== RAW_FORMAT) return null
  try {
    const m = parseGallery(JSON.parse(raw.raw_json), raw.raw_format)
    return m.coverPath ? m : null
  } catch {
    return null
  }
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

// ================= 背景佇列（只在前景執行） =================
// 兩個工作者各自從資料庫取下一本（依 queue_seq＝加入順序）：
// - meta：API 隊伍補詳細資料（meta_pending → cover_pending）
// - cover：圖片隊伍抓封面（cover_pending → ok）
// 佇列就是 books.fetch_status，存在資料庫，App 重開後自動繼續。
const NET_RETRY_MS = 30_000

export async function refreshPendingCount() {
  pendingCount.value = (
    await query("SELECT COUNT(*) AS n FROM books WHERE fetch_status IN ('meta_pending', 'cover_pending')")
  )[0].n
}

const workers = {
  meta: { running: false, again: false, timer: null, promise: null },
  cover: { running: false, again: false, timer: null, promise: null },
}
let paused = false

function updateRunning() {
  queueRunning.value = workers.meta.running || workers.cover.running
}

/** 啟動某個工作者；正在跑就讓它跑完後再檢查一次（避免剛加入的書被漏掉） */
function kick(name) {
  if (paused) return Promise.resolve()
  const w = workers[name]
  if (w.running) {
    w.again = true
    return w.promise
  }
  clearTimeout(w.timer)
  w.timer = null
  w.running = true
  w.again = false
  updateRunning()
  w.promise = (name === 'meta' ? metaLoop() : coverLoop())
    .catch((e) => console.warn(`${name} worker`, e))
    .finally(async () => {
      w.running = false
      updateRunning()
      await refreshPendingCount().catch(() => {})
      if (w.again && !paused && !w.timer) kick(name)
    })
  return w.promise
}

function retryLater(name, ms) {
  const w = workers[name]
  clearTimeout(w.timer)
  w.timer = setTimeout(() => {
    w.timer = null
    kick(name)
  }, ms)
}

/** 回到前景、網路恢復、按「繼續抓取」時呼叫 */
export function runQueue() {
  paused = false
  queueState.error = null
  return Promise.all([kick('meta'), kick('cover')])
}

/** 切到背景時呼叫：目前這本做完就停 */
export function stopQueue() {
  paused = true
  for (const w of Object.values(workers)) {
    clearTimeout(w.timer)
    w.timer = null
  }
}

async function nextPending(status) {
  return (
    await query(
      'SELECT gallery_id FROM books WHERE fetch_status = ? ORDER BY queue_seq IS NULL, queue_seq, gallery_id LIMIT 1',
      [status],
    )
  )[0]
}

async function setStatus(id, status) {
  await run('UPDATE books SET fetch_status = ? WHERE gallery_id = ?', [status, id])
}

/** 需要使用者處理的錯誤：停下工作者並顯示 */
const FATAL = [E.WRITE_FAILED, E.STORAGE_FULL, E.DB_FAILED, E.ENDPOINT_INVALID]

async function metaLoop() {
  while (!paused) {
    const row = await nextPending('meta_pending')
    if (!row) break
    const id = row.gallery_id
    let d
    try {
      d = await fetchDetail(id)
    } catch (err) {
      const e = toAppError(err)
      if (e.code === E.NOT_FOUND) {
        await setStatus(id, 'not_found')
      } else if (e.code === E.BAD_FORMAT) {
        await setStatus(id, 'meta_failed')
      } else if (e.code === E.RATE_LIMITED) {
        const ms = (e.retryAfter || 30) * 1000
        queueState.apiWaitUntil = Date.now() + ms
        retryLater('meta', ms)
        return
      } else if (e.code === E.CHALLENGE) {
        queueState.challenge = true // 等使用者按「進行驗證」
        return
      } else if (FATAL.includes(e.code)) {
        queueState.error = e.code
        return
      } else {
        // 離線、逾時、被擋：不算失敗，留在佇列稍後自動重試
        queueState.netWaitUntil = Date.now() + NET_RETRY_MS
        retryLater('meta', NET_RETRY_MS)
        return
      }
      bump()
      await refreshPendingCount()
      continue
    }
    queueState.apiWaitUntil = 0
    queueState.netWaitUntil = 0
    queueState.challenge = false
    if (!(await getBook(id))) continue // 查詢途中被刪除或改了 ID
    try {
      await transaction([
        {
          statement:
            "UPDATE books SET media_id = ?, title = ?, title_ja = ?, cover_ext = ?, fetch_status = CASE WHEN fetch_status = 'meta_pending' THEN 'cover_pending' ELSE fetch_status END WHERE gallery_id = ?",
          values: [d.meta.mediaId, d.meta.title, d.meta.titleJa, d.meta.coverExt, id],
        },
        {
          statement: 'INSERT OR REPLACE INTO book_raw(gallery_id, raw_json, raw_format) VALUES (?,?,?)',
          values: [id, d.rawJson, d.rawFormat],
        },
      ])
    } catch (err) {
      queueState.error = dbError(err).code
      return
    }
    bump()
    kick('cover') // 書名有了，封面交給圖片隊伍
  }
}

async function coverLoop() {
  while (!paused) {
    const row = await nextPending('cover_pending')
    if (!row) break
    const id = row.gallery_id
    const meta = await localCoverMeta(id)
    if (!meta) {
      // 沒有可用的原始資料（舊格式或損壞）→ 先補資料
      await setStatus(id, 'meta_pending')
      kick('meta')
      continue
    }
    try {
      const res = await downloadCover(id, meta, `refetch/${id}-${Date.now()}.tmp`)
      await replaceCover(id, res)
      queueState.imgWaitUntil = 0
      queueState.netWaitUntil = 0
    } catch (err) {
      const e = toAppError(err)
      if (e.code === E.RATE_LIMITED) {
        const ms = (e.retryAfter || 30) * 1000
        queueState.imgWaitUntil = Date.now() + ms
        retryLater('cover', ms)
        return
      }
      if (FATAL.includes(e.code)) {
        queueState.error = e.code
        return
      }
      if (e.code === E.OFFLINE || e.code === E.TIMEOUT) {
        queueState.netWaitUntil = Date.now() + NET_RETRY_MS
        retryLater('cover', NET_RETRY_MS)
        return
      }
      await setStatus(id, 'no_cover') // 封面失敗；⋮「重抓封面」可重試
    }
    bump()
    await refreshPendingCount()
  }
}

/** 設定頁「重抓所有缺少的封面」：把沒有封面或封面檔不見的書排回佇列 */
export async function markMissingCoversPending() {
  const { files } = await Filesystem.readdir({ path: COVERS_DIR, directory: Directory.Data }).catch(() => ({
    files: [],
  }))
  const present = new Set(files.map((f) => (typeof f === 'string' ? f : f.name)))
  const rows = await query('SELECT gallery_id, cover_path, fetch_status FROM books ORDER BY added_at, gallery_id')
  const ids = rows
    .filter((r) => !['meta_pending', 'cover_pending', 'not_found'].includes(r.fetch_status))
    .filter((r) => !r.cover_path || !present.has(r.cover_path.split('/').pop()))
    .map((r) => r.gallery_id)
  if (ids.length) {
    await transaction(
      ids.map((id) => ({
        statement: `UPDATE books SET queue_seq = ?, fetch_status = CASE
            WHEN EXISTS (SELECT 1 FROM book_raw r WHERE r.gallery_id = books.gallery_id AND r.raw_format = ?) THEN 'cover_pending'
            ELSE 'meta_pending' END
          WHERE gallery_id = ?`,
        values: [nextSeq(), RAW_FORMAT, id],
      })),
    )
  }
  await refreshPendingCount()
  bump()
  return ids.length
}

// ================= 從瀏覽器分享 =================
function handleSharedText(text) {
  if (!text) return
  sharedInput.value = { id: extractGalleryId(text), at: Date.now() }
}

/** App 啟動後呼叫一次：處理冷啟動帶進來的分享，並監聽 App 在背景時收到的分享 */
export async function listenForShares() {
  await onShareReceived(async () => handleSharedText(await takeSharedText()))
  handleSharedText(await takeSharedText())
}

// ================= Cloudflare 驗證 =================
/**
 * 顯示驗證畫面讓使用者手動通過 Cloudflare challenge。
 * @param {{title:string, closeLabel:string}} labels 由介面以 t() 提供
 * @returns {Promise<boolean>} 是否通過
 */
export async function verifyChallenge(labels) {
  const passed = await showChallenge(labels)
  if (passed) {
    queueState.challenge = false
    runQueue()
  }
  return passed
}

/** 設定頁「重設驗證」：清除 nhentai 的 cookie，auto 模式重新從原生請求試起 */
export async function resetVerification() {
  await clearSession()
  await setSetting('last_fetch_ok', '')
}

// ================= 健康檢查 =================
export async function testConnection() {
  const id = Number.parseInt(settings.test_id, 10) || 228922
  const result = { detail: null, cover: null, diagnostics: null }
  let coverDiag = null
  try {
    const d = await fetchDetail(id)
    result.detail = 'ok'
    try {
      const res = await downloadCover(id, d.meta, `test/${id}.tmp`, { diagnose: true })
      result.cover = 'ok'
      await Filesystem.deleteFile({ path: res.path, directory: Directory.Cache }).catch(() => {})
    } catch (err) {
      const e = toAppError(err)
      // 介面以 errText 顯示，只能給已知錯誤碼；原始錯誤在診斷的 cover.attempts
      result.cover = Object.values(E).includes(e.cause) ? e.cause : e.code
    }
  } catch (err) {
    result.detail = toAppError(err).code
  }
  if (result.detail === 'ok') coverDiag = getLastCoverTrace() // 詳情失敗時沒有試封面，不顯示舊紀錄
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

const TEMP_DIRS = [PREVIEW_DIR, 'refetch', 'test', 'export']

/** 暫存資料夾（preview/、refetch/、test/、export/）的總大小；收藏封面不算在內。 */
export async function tempCacheSize() {
  let bytes = 0
  let count = 0
  for (const dir of TEMP_DIRS) {
    const { files } = await Filesystem.readdir({ path: dir, directory: Directory.Cache }).catch(() => ({ files: [] }))
    for (const f of files) {
      if (typeof f === 'string' || f.type === 'directory') continue
      count++
      bytes += Number(f.size) || 0
    }
  }
  return { count, bytes }
}

/** 「清除封面快取」：只清暫存資料夾，收藏封面不刪。 */
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
        "INSERT OR IGNORE INTO books(gallery_id, title, title_ja, note, fetch_status, added_at, queue_seq) VALUES (?, '', '', ?, 'meta_pending', ?, ?)",
      values: [r.gallery_id, r.note || null, r.added_at, nextSeq()],
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
  runQueue()
}

export { setSetting, settings }
