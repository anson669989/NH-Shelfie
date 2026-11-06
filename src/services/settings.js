// settings 表的鍵值存取，並同步到一個 reactive 物件供介面使用。
import { reactive } from 'vue'
import { query, run } from './db.js'

export const DEFAULT_ENDPOINTS = Object.freeze({
  endpoint_detail: 'https://nhentai.net/api/gallery/{id}',
  endpoint_cover: 'https://t.nhentai.net/galleries/{media_id}/cover.{ext}',
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
  test_id: '177013',
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
