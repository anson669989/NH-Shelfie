// 純函式：不碰網路、資料庫與 Capacitor，方便單元測試。
import { AppError, E } from './errors.js'

/** 全形數字、全形＃ → 半形，方便後續比對 */
function toHalfWidth(s) {
  return String(s).replace(/[０-９＃]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

function toId(digits) {
  if (!digits || digits.length > 7) return null
  const n = Number.parseInt(digits, 10)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return n
}

/**
 * 解析使用者輸入：接受 1–7 位正整數、`#228922`／`# 228922`／全形＃，或含 /g/{id} 的網址。
 * @returns {number|null}
 */
export function parseGalleryId(input) {
  if (input == null) return null
  const s = toHalfWidth(input).trim()
  if (!s) return null
  let m = s.match(/^#?\s*(\d+)$/)
  if (m) return toId(m[1])
  m = s.match(/\/g\/(\d+)(?:[/?#]|$)/i)
  return m ? toId(m[1]) : null
}

/**
 * 從分享進來的一段文字找出第一個 gallery ID（依出現位置取最前面的一個）。
 * 認得：/g/{id} 網址、#123456、或整段只有數字。
 * @returns {number|null}
 */
export function extractGalleryId(text) {
  if (text == null) return null
  const s = toHalfWidth(text)
  if (/^\s*#?\s*\d+\s*$/.test(s)) return parseGalleryId(s)
  const re = /\/g\/(\d{1,7})(?=[/?#\s]|$)|#\s?(\d{1,7})(?!\d)/gi
  let m
  while ((m = re.exec(s))) {
    const id = toId(m[1] || m[2])
    if (id) return id
  }
  return null
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

export const RAW_FORMATS = Object.freeze(['api-v1', 'api-v2'])

/**
 * 寬鬆解析 nhentai 詳情回應，輸出固定的 BookMeta。
 * 必要欄位（media_id、封面類型／路徑）缺少時丟 BAD_FORMAT。
 * - api-v1：舊 `/api/gallery/{id}`（站方已停用；保留給已存的 book_raw）
 * - api-v2：`/api/v2/galleries/{id}`，另輸出 `coverPath`（CDN 相對路徑，原樣使用）
 * @param {object} json
 * @param {string} rawFormat 回應版本標記，日後格式變動時依版本選解析器
 */
export function parseGallery(json, rawFormat = 'api-v1') {
  if (!RAW_FORMATS.includes(rawFormat)) throw new AppError(E.BAD_FORMAT, { reason: 'unknown raw_format' })
  if (!json || typeof json !== 'object') throw new AppError(E.BAD_FORMAT, { reason: 'not object' })

  const mediaId = json.media_id != null ? String(json.media_id) : ''
  if (!/^\d+$/.test(mediaId)) throw new AppError(E.BAD_FORMAT, { reason: 'media_id' })

  let coverExt
  let coverPath = null
  if (rawFormat === 'api-v2') {
    const c = parseCoverPath(json.cover?.path)
    if (!c || c.mediaId !== mediaId) throw new AppError(E.BAD_FORMAT, { reason: 'cover path' })
    coverExt = c.ext
    coverPath = c.path
  } else {
    coverExt = EXT_BY_TYPE[String(json.images?.cover?.t || '').toLowerCase()]
    if (!coverExt) throw new AppError(E.BAD_FORMAT, { reason: 'cover type' })
  }

  const t = json.title || {}
  const title = pickStr(t.pretty) || pickStr(t.english) || pickStr(t.japanese) || ''
  const titleJa = pickStr(t.japanese) || ''
  const titleEn = pickStr(t.english) || ''

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
    coverPath,
    title,
    titleJa,
    titleEn,
    tags,
  }
}

function pickStr(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

// v2 封面相對路徑，例 galleries/1205270/cover.jpg、galleries/4301004/cover.jpg.webp
const COVER_PATH_RE = /^galleries\/(\d{1,12})\/cover\.([a-z0-9]{2,5})(?:\.([a-z0-9]{2,5}))?$/i

/**
 * 驗證 v2 的 cover.path。只接受已知格式；實際格式取最後一段副檔名（jpg.webp → webp）。
 * @returns {{path:string, mediaId:string, ext:string}|null}
 */
export function parseCoverPath(path) {
  if (typeof path !== 'string') return null
  const m = path.match(COVER_PATH_RE)
  if (!m) return null
  const ext = EXT_BY_TYPE[(m[3] || m[2]).toLowerCase()]
  if (!ext) return null
  return { path, mediaId: m[1], ext }
}

/** CDN 伺服器字串 → 正規化 origin；只接受 https、nhentai.net 子網域，不可帶路徑／帳密／埠號／查詢字串。 */
export function normalizeCdnServer(server) {
  let u
  try {
    u = new URL(String(server))
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return null
  if (u.pathname !== '/' && u.pathname !== '') return null
  const host = u.hostname.toLowerCase()
  if (!(host === 'nhentai.net' || host.endsWith('.nhentai.net'))) return null
  return `https://${host}`
}

/**
 * 解析 `GET /api/v2/cdn` 的 CdnConfigResponse，只留合法的縮圖伺服器。
 * @returns {{thumbServers: string[]}}
 */
export function parseCdnConfig(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.thumb_servers)) {
    throw new AppError(E.BAD_FORMAT, { reason: 'cdn config' })
  }
  const thumbServers = [...new Set(json.thumb_servers.map(normalizeCdnServer).filter(Boolean))]
  if (!thumbServers.length) throw new AppError(E.BAD_FORMAT, { reason: 'cdn servers' })
  return { thumbServers }
}

/** 封面網址＝白名單 CDN 伺服器 + 通過驗證的 cover.path（原樣使用，不猜副檔名）。 */
export function buildCdnUrl(server, coverPath) {
  const origin = normalizeCdnServer(server)
  if (!origin || !parseCoverPath(coverPath)) throw new AppError(E.ENDPOINT_INVALID, { server, coverPath })
  return `${origin}/${coverPath}`
}

/**
 * 封面主機順序：上次成功的主機排第一，其餘照 /api/v2/cdn 的順序（t1→t2→t3→t4）。
 * preferred 不在清單內就忽略（清單可能已變動）。
 */
export function orderServers(servers, preferred) {
  const list = Array.isArray(servers) ? servers.filter(Boolean) : []
  const p = preferred ? normalizeCdnServer(preferred) : null
  if (!p || !list.includes(p)) return list
  return [p, ...list.filter((s) => s !== p)]
}

/**
 * 把原生下載／檔案操作丟出的原始錯誤分類成錯誤碼（不碰網路）。
 * 順序有意義：寫檔類訊息優先，避免檔案錯誤被當成離線。
 * @param {any} err 外掛錯誤（取 message）或字串
 * @param {{online?: boolean}} [env] online === false 代表系統回報離線
 * @returns {string} E.* 其中之一
 */
export function classifyDownloadError(err, { online } = {}) {
  const msg = String(err?.message ?? err?.errorMessage ?? err ?? '')
  if (/\b429\b|Too Many Requests/i.test(msg)) return E.RATE_LIMITED
  if (/ENOSPC|No space left|disk full|SQLITE_FULL/i.test(msg)) return E.STORAGE_FULL
  if (/ENOENT|No such file or directory|open failed|EACCES|EROFS|EISDIR|Permission denied|Read-only file system|FileNotFound|Unable to (create|write)|Directory does not exist|Parent folder doesn't exist/i.test(msg)) {
    return E.WRITE_FAILED
  }
  if (online === false) return E.OFFLINE
  if (/time ?out|timed out|SocketTimeout/i.test(msg)) return E.TIMEOUT
  if (/UnknownHost|Unable to resolve host|ENOTFOUND|ECONNREFUSED|ECONNRESET|ENETUNREACH|Network is unreachable|Failed to connect|Connection (refused|reset)/i.test(msg)) {
    return E.OFFLINE
  }
  return E.COVER_FAILED
}

/** 舊 API 停用時的回應：403／410 且內文含「Use new API」（不是被 Cloudflare 擋）。 */
export function isApiRetired({ status, body } = {}) {
  if (status !== 403 && status !== 410) return false
  const text = typeof body === 'string' ? body.slice(0, 4096) : ''
  return /Use new API/i.test(text)
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

// Cloudflare challenge／攔截頁的特徵字串。原生外掛 NhWebFetchPlugin.java 的 CHALLENGE_MARKERS 要同步。
const CHALLENGE_MARKERS = /Just a moment\.\.\.|cf-chl|cf_chl_opt|challenge-platform|Attention Required! \| Cloudflare/i

/**
 * 判斷一個 HTTP 回應是否為 Cloudflare challenge／攔截頁（而非 API 資料）。
 * - 內文含 challenge 特徵字串 → true
 * - 403 / 503 且是 HTML → true（Cloudflare 擋下時的典型回應）
 * @param {{status?:number, contentType?:string, body?:string}} res
 */
export function isChallengePage({ status, contentType, body } = {}) {
  const text = typeof body === 'string' ? body.slice(0, 32_768) : ''
  if (CHALLENGE_MARKERS.test(text)) return true
  const isHtml = /text\/html/i.test(String(contentType || '')) || /^\s*<(!doctype|html)/i.test(text)
  return (status === 403 || status === 503) && isHtml
}

/** 資料夾名稱：去頭尾空白、1–30 字。回傳整理後名稱或 null。 */
export function normalizeFolderName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim()
  const len = [...s].length
  if (len < 1 || len > 30) return null
  return s
}
