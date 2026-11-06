// 純函式：不碰網路、資料庫與 Capacitor，方便單元測試。
import { AppError, E } from './errors.js'

/**
 * 解析使用者輸入：接受 1–7 位正整數，或含 /g/{id} 的網址。
 * @returns {number|null}
 */
export function parseGalleryId(input) {
  if (input == null) return null
  const s = String(input).trim()
  if (!s) return null
  let digits = null
  if (/^\d+$/.test(s)) {
    digits = s
  } else {
    const m = s.match(/\/g\/(\d+)(?:[/?#]|$)/i)
    if (m) digits = m[1]
  }
  if (!digits || digits.length > 7) return null
  const n = Number.parseInt(digits, 10)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return n
}

/** 只以整數 / 純數字字串套範本組網址，避免拼出意外網址。 */
export function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (all, key) => {
    if (!(key in vars)) throw new AppError(E.ENDPOINT_INVALID, { key })
    const v = String(vars[key])
    if (!/^[A-Za-z0-9]+$/.test(v)) throw new AppError(E.ENDPOINT_INVALID, { key })
    return v
  })
}

/** 檢查端點範本：只接受 https，且必須包含必要的佔位符。 */
export function validateEndpointTemplate(tpl, required) {
  let url
  try {
    url = new URL(String(tpl).replace(/\{(\w+)\}/g, '0'))
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  return required.every((k) => String(tpl).includes(`{${k}}`))
}

export function hostOf(tpl) {
  try {
    return new URL(String(tpl).replace(/\{(\w+)\}/g, '0')).hostname.toLowerCase()
  } catch {
    return null
  }
}

const EXT_BY_TYPE = { j: 'jpg', p: 'png', w: 'webp', jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp' }

/**
 * 寬鬆解析 nhentai 詳情回應，輸出固定的 BookMeta。
 * 必要欄位（media_id、封面類型）缺少時丟 BAD_FORMAT。
 * @param {object} json
 * @param {string} rawFormat 回應版本標記，日後格式變動時依版本選解析器
 */
export function parseGallery(json, rawFormat = 'api-v1') {
  if (rawFormat !== 'api-v1') throw new AppError(E.BAD_FORMAT, { reason: 'unknown raw_format' })
  if (!json || typeof json !== 'object') throw new AppError(E.BAD_FORMAT, { reason: 'not object' })

  const mediaId = json.media_id != null ? String(json.media_id) : ''
  if (!/^\d+$/.test(mediaId)) throw new AppError(E.BAD_FORMAT, { reason: 'media_id' })

  const coverType = json.images?.cover?.t
  const coverExt = EXT_BY_TYPE[String(coverType || '').toLowerCase()]
  if (!coverExt) throw new AppError(E.BAD_FORMAT, { reason: 'cover type' })

  const t = json.title || {}
  const title = pickStr(t.pretty) || pickStr(t.english) || pickStr(t.japanese) || ''
  const titleJa = pickStr(t.japanese) || ''

  const tags = Array.isArray(json.tags)
    ? json.tags
        .filter((x) => x && typeof x.name === 'string' && typeof x.type === 'string')
        .map((x) => ({ type: x.type, name: x.name }))
    : []

  const galleryId = Number.parseInt(json.id, 10)
  return {
    galleryId: Number.isSafeInteger(galleryId) ? galleryId : null,
    mediaId,
    coverExt,
    title,
    titleJa,
    tags,
  }
}

function pickStr(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

/** 以檔頭判斷圖片格式；接受 base64 字串或 Uint8Array。 */
export function sniffImageExt(input) {
  let b
  if (typeof input === 'string') {
    const head = input.replace(/^data:[^,]*,/, '').slice(0, 24)
    const bin = typeof atob === 'function' ? atob(head) : Buffer.from(head, 'base64').toString('binary')
    b = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } else {
    b = input
  }
  if (!b || b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return 'webp'
  return null
}

/** 資料夾名稱：去頭尾空白、1–30 字。回傳整理後名稱或 null。 */
export function normalizeFolderName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim()
  const len = [...s].length
  if (len < 1 || len > 30) return null
  return s
}
