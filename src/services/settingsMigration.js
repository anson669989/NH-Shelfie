// 純函式：設定遷移規則（不碰資料庫），由 settings.js 的 migrateSettings() 套用。

// 舊預設值：使用者存的若仍是這些值就換成新預設；自訂過的不動
export const LEGACY_DEFAULTS = Object.freeze({
  endpoint_detail: ['https://nhentai.net/api/gallery/{id}'],
  test_id: ['177013'],
})

// 已廢除的設定鍵
export const REMOVED_KEYS = Object.freeze(['endpoint_cover'])

// 一次性遷移的目前版本
export const SETTINGS_REV = 1

/**
 * 依目前設定算出要改的值。
 * @param {Record<string,string>} current 目前設定（已載入預設值）
 * @param {Record<string,string>} defaults DEFAULTS
 * @returns {{set: Record<string,string>, remove: string[]}}
 */
export function planSettingsMigration(current, defaults) {
  const set = {}
  for (const [k, olds] of Object.entries(LEGACY_DEFAULTS)) {
    if (olds.includes(current[k]) && current[k] !== defaults[k]) set[k] = defaults[k]
  }
  const rev = Number.parseInt(current.settings_rev, 10) || 0
  if (rev < 1) {
    // v0.1.1 舊 API 停用時，原生 403 被誤判成 Cloudflare 而記住了 webview；清掉讓 auto 從原生試起
    if (current.last_fetch_ok === 'webview') set.last_fetch_ok = ''
  }
  if (rev < SETTINGS_REV) set.settings_rev = String(SETTINGS_REV)
  return { set, remove: [...REMOVED_KEYS] }
}
