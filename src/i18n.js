// 介面字串的取用；字串本身在 locales.js（繁中 / 简中 / English / 日本語 四份同步）。介面以 t('key', {var}) 取用。
import { computed } from 'vue'
import { settings } from './services/settings.js'
import { DICTS, LANGUAGES, detectLang } from './locales.js'

export { LANGUAGES }

function systemLang() {
  const nav = typeof navigator !== 'undefined' ? navigator : null
  return detectLang(nav?.languages?.[0] || nav?.language || 'zh-TW')
}

export const currentLang = computed(() => (DICTS[settings.language] ? settings.language : systemLang()))

export function t(key, vars = {}) {
  const dict = DICTS[currentLang.value] || DICTS['zh-TW']
  let s = dict[key] ?? DICTS['zh-TW'][key] ?? key
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return s
}

/** 依錯誤碼取得訊息 */
export function errText(err) {
  const code = err?.code || 'UNKNOWN'
  return t(`err.${code}`, { sec: err?.retryAfter ?? 30 })
}
