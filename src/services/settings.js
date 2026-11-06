// settings 表的鍵值存取，並同步到一個 reactive 物件供介面使用。
import { reactive } from 'vue'
import { query, run } from './db.js'

export const DEFAULT_ENDPOINTS = Object.freeze({
  endpoint_detail: 'https://nhentai.net/api/v2/galleries/{id}',
  endpoint_cdn: 'https://nhentai.net/api/v2/cdn', // 封面伺服器清單；封面網址＝伺服器 + 詳情回應的 cover.path
  endpoint_page: 'https://nhentai.net/g/{id}/',
})

export const DEFAULTS = Object.freeze({
  theme_color: '#ed2553',
  dark_mode: 'system', // system | light | dark
  language: '', // 空字串＝依系統語言
  grid_columns: '3',
  sort_all: 'added_desc',
  sort_uncat: 'added_desc',
  last_folders: '[]',
  last_export_at: '',
  test_id: '228922',
  fetch_mode: 'auto', // auto | native | webview
  last_fetch_ok: '', // auto 模式記住上次成功的方式：native | webview
  cdn_cache: '', // JSON {src, at, servers}：/api/v2/cdn 的快取（24 小時）
  settings_rev: '0', // 一次性設定遷移的版本（見 migrateSettings）
  dev_mode: '0', // 1 = 顯示開發者選項（關於 → 版本 連點 7 次切換）
  ...DEFAULT_ENDPOINTS,
})

export const settings = reactive({ ...DEFAULTS })

export async function loadSettings() {
  const rows = await query('SELECT key, value FROM settings')
  for (const { key, value } of rows) {
    if (key in DEFAULTS && value != null) settings[key] = value
  }
  return settings
}

export async function setSetting(key, value) {
  const v = value == null ? '' : String(value)
  settings[key] = v
  await run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    v,
  ])
}

export async function resetEndpoints() {
  for (const [k, v] of Object.entries(DEFAULT_ENDPOINTS)) await setSetting(k, v)
}

// 舊預設值：使用者存的若仍是這些值就換成新預設；自訂過的不動
const LEGACY_DEFAULTS = Object.freeze({
  endpoint_detail: ['https://nhentai.net/api/gallery/{id}'],
  test_id: ['177013'],
})
const REMOVED_KEYS = ['endpoint_cover']

/** 啟動時在 loadSettings 之後呼叫一次。 */
export async function migrateSettings() {
  for (const [k, olds] of Object.entries(LEGACY_DEFAULTS)) {
    if (olds.includes(settings[k])) await setSetting(k, DEFAULTS[k])
  }
  for (const k of REMOVED_KEYS) await run('DELETE FROM settings WHERE key = ?', [k])
  if ((Number.parseInt(settings.settings_rev, 10) || 0) < 1) {
    // v0.1.1 舊 API 停用時，原生 403 被誤判成 Cloudflare 而記住了 webview；清掉讓 auto 從原生試起
    if (settings.last_fetch_ok === 'webview') await setSetting('last_fetch_ok', '')
    await setSetting('settings_rev', '1')
  }
}
