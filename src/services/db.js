// SQLite 存取（@capacitor-community/sqlite）。所有查詢一律參數化。
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'

const DB_NAME = 'nhcollection'
let sqlite = null
let conn = null

// 以 PRAGMA user_version 記 schema 版本，逐版遷移。
// 新增版本時在陣列尾端加一個元素即可；不要改動已發佈的舊版本。
const MIGRATIONS = [
  // v1：路線 A
  `
  CREATE TABLE IF NOT EXISTS books (
    gallery_id   INTEGER PRIMARY KEY,
    media_id     TEXT,
    title        TEXT NOT NULL DEFAULT '',
    title_ja     TEXT NOT NULL DEFAULT '',
    cover_path   TEXT,
    cover_ext    TEXT,
    cover_rev    INTEGER NOT NULL DEFAULT 0,
    note         TEXT,
    fetch_status TEXT NOT NULL DEFAULT 'ok',
    added_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS book_raw (
    gallery_id INTEGER PRIMARY KEY REFERENCES books(gallery_id) ON DELETE CASCADE,
    raw_json   TEXT NOT NULL,
    raw_format TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    sort_mode  TEXT NOT NULL DEFAULT 'added_desc',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS book_folders (
    gallery_id INTEGER NOT NULL REFERENCES books(gallery_id) ON DELETE CASCADE,
    folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    PRIMARY KEY (gallery_id, folder_id)
  );
  CREATE INDEX IF NOT EXISTS idx_book_folders_folder ON book_folders(folder_id);
  CREATE INDEX IF NOT EXISTS idx_books_status ON books(fetch_status);
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS fetch_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    gallery_id  INTEGER,
    kind        TEXT,
    http_status INTEGER,
    error_code  TEXT
  );
  `,
  // v2（路線 B，M5 時啟用）：tags / book_tags —— 目前尚未加入，標籤可由 book_raw 本地解析補建。
]

export async function initDb() {
  if (conn) return conn
  sqlite = new SQLiteConnection(CapacitorSQLite)
  await sqlite.checkConnectionsConsistency().catch(() => {})
  const exists = (await sqlite.isConnection(DB_NAME, false)).result
  conn = exists
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false)
  await conn.open()
  await conn.execute('PRAGMA foreign_keys = ON;', false)
  await migrate()
  return conn
}

async function migrate() {
  const cur = Number((await query('PRAGMA user_version'))[0]?.user_version || 0)
  if (cur >= MIGRATIONS.length) return
  if (cur > 0) {
    // 已有資料時，遷移前先備份資料庫檔
    await backupDatabase(cur).catch((e) => console.warn('backup failed', e))
  }
  for (let v = cur; v < MIGRATIONS.length; v++) {
    await conn.execute(MIGRATIONS[v], true)
    await conn.execute(`PRAGMA user_version = ${v + 1};`, false)
  }
}

async function backupDatabase(version) {
  // 以 SQLite 內建 VACUUM INTO 複製一份到資料庫所在目錄（App 私有目錄，不需額外權限）
  const main = (await query('PRAGMA database_list')).find((r) => r.name === 'main')
  if (!main?.file) return
  const dir = main.file.replace(/[^/]+$/, '')
  const target = `${dir}nhcollection-backup-v${Number(version)}.db`.replace(/'/g, "''")
  await conn.execute(`VACUUM INTO '${target}';`, false)
}

export async function query(sql, values = []) {
  const res = await conn.query(sql, values)
  return res.values || []
}

export async function run(sql, values = []) {
  const res = await conn.run(sql, values, true)
  return res.changes || {}
}

/**
 * 在單一交易內執行多個語句；任一失敗整批回滾。
 * @param {{statement:string, values:any[]}[]} set
 */
export async function transaction(set) {
  if (!set.length) return
  await conn.executeSet(set, true)
}
