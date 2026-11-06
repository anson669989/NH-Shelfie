// 轉接層：所有對 nhentai 的請求與解析都集中在這裡，對內只輸出固定的 BookMeta。
// 站方改版時只需要修改這個檔（或在設定頁「進階」修改端點範本）。
import { CapacitorHttp } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { AppError, E } from './errors.js'
import { fillTemplate, hostOf, parseGallery, sniffImageExt } from './parse.js'
import { settings, DEFAULT_ENDPOINTS } from './settings.js'

const DETAIL_TIMEOUT = 10_000
const COVER_TIMEOUT = 20_000
const MIN_INTERVAL = 1_000 // 全局節流：同時只 1 個請求、間隔至少 1 秒
const MAX_COVER_BYTES = 5 * 1024 * 1024
export const RAW_FORMAT = 'api-v1'

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

let logger = null
/** 由服務層注入抓取紀錄函式 (entry) => Promise */
export function setFetchLogger(fn) {
  logger = fn
}
function log(entry) {
  try {
    logger?.({ at: Math.floor(Date.now() / 1000), ...entry })
  } catch {
    /* 紀錄失敗不影響主流程 */
  }
}

// ---------- 全局節流 ----------
let chain = Promise.resolve()
let lastAt = 0
let blockedUntil = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function schedule(fn) {
  const task = chain.then(async () => {
    const now = Date.now()
    if (now < blockedUntil) {
      throw new AppError(E.RATE_LIMITED, { retryAfter: Math.ceil((blockedUntil - now) / 1000) })
    }
    const wait = lastAt + MIN_INTERVAL - now
    if (wait > 0) await sleep(wait)
    try {
      return await fn()
    } finally {
      lastAt = Date.now()
    }
  })
  chain = task.catch(() => {})
  return task
}

export function rateLimitRemaining() {
  return Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000))
}

// ---------- 網址 ----------
function endpoint(key) {
  return settings[key] || DEFAULT_ENDPOINTS[key]
}

/** 白名單：nhentai.net 與其子網域，以及使用者設定的端點網域 */
function allowedHosts() {
  const hosts = new Set()
  for (const k of Object.keys(DEFAULT_ENDPOINTS)) {
    const h = hostOf(endpoint(k))
    if (h) hosts.add(h)
  }
  return hosts
}
function assertAllowed(url) {
  const u = new URL(url)
  const host = u.hostname.toLowerCase()
  const ok = u.protocol === 'https:' && (host === 'nhentai.net' || host.endsWith('.nhentai.net') || allowedHosts().has(host))
  if (!ok) throw new AppError(E.ENDPOINT_INVALID, { url })
}

export function galleryPageUrl(id) {
  const url = fillTemplate(endpoint('endpoint_page'), { id: Math.trunc(Number(id)) })
  assertAllowed(url)
  return url
}

// ---------- 詳情 ----------
function header(res, name) {
  const h = res.headers || {}
  const key = Object.keys(h).find((k) => k.toLowerCase() === name)
  return key ? String(h[key]) : ''
}

function classifyNetworkError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return new AppError(E.OFFLINE)
  const msg = String(err?.message || err || '')
  if (/time ?out|timed out|SocketTimeout/i.test(msg)) return new AppError(E.TIMEOUT)
  if (/UnknownHost|Unable to resolve|ENOTFOUND|network|connect/i.test(msg)) return new AppError(E.OFFLINE)
  return new AppError(E.OFFLINE, { cause: msg })
}

async function requestDetailOnce(id, useMobileUa) {
  const url = fillTemplate(endpoint('endpoint_detail'), { id })
  assertAllowed(url)
  let res
  try {
    res = await CapacitorHttp.get({
      url,
      headers: { Accept: 'application/json', ...(useMobileUa ? { 'User-Agent': MOBILE_UA } : {}) },
      connectTimeout: DETAIL_TIMEOUT,
      readTimeout: DETAIL_TIMEOUT,
      responseType: 'json',
    })
  } catch (err) {
    throw classifyNetworkError(err)
  }
  const status = res.status
  if (status === 404) throw new AppError(E.NOT_FOUND, { httpStatus: status })
  if (status === 429) {
    const ra = Number.parseInt(header(res, 'retry-after'), 10)
    const sec = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 600) : 30
    blockedUntil = Date.now() + sec * 1000
    throw new AppError(E.RATE_LIMITED, { httpStatus: status, retryAfter: sec })
  }
  let data = res.data
  const ctype = header(res, 'content-type')
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      data = null
    }
  }
  if (status === 403 || status === 503 || /text\/html/i.test(ctype) || data == null) {
    throw new AppError(E.BLOCKED, { httpStatus: status })
  }
  if (status < 200 || status >= 300) throw new AppError(E.BLOCKED, { httpStatus: status })
  return { data, status }
}

/**
 * 取得詳情並解析。
 * - 逾時：自動重試 1 次
 * - 被擋（403/503/HTML）：帶手機瀏覽器 User-Agent 重試 1 次
 * @returns {Promise<{meta: object, rawJson: string, rawFormat: string}>}
 */
export async function fetchDetail(id) {
  id = Math.trunc(Number(id))
  return schedule(async () => {
    let lastErr
    for (const attempt of [
      { ua: false },
      { ua: false, onlyIf: E.TIMEOUT },
      { ua: true, onlyIf: E.BLOCKED },
    ]) {
      if (attempt.onlyIf && lastErr?.code !== attempt.onlyIf) continue
      if (lastErr) await sleep(MIN_INTERVAL)
      try {
        const { data, status } = await requestDetailOnce(id, attempt.ua)
        const meta = parseGallery(data, RAW_FORMAT)
        log({ gallery_id: id, kind: 'detail', http_status: status, error_code: null })
        return { meta: { ...meta, galleryId: id }, rawJson: JSON.stringify(data), rawFormat: RAW_FORMAT }
      } catch (err) {
        lastErr = err instanceof AppError ? err : classifyNetworkError(err)
        if (lastErr.code === E.BAD_FORMAT || lastErr.code === E.NOT_FOUND || lastErr.code === E.RATE_LIMITED) break
      }
    }
    log({ gallery_id: id, kind: 'detail', http_status: lastErr.httpStatus ?? null, error_code: lastErr.code })
    throw lastErr
  })
}

// ---------- 封面 ----------
/**
 * 以原生下載把封面存到快取目錄（不經 base64 橋接），並驗證檔頭與大小。
 * @param {{mediaId:string, coverExt:string}} meta
 * @param {string} cachePath 例如 preview/123456.tmp（相對於 Directory.Cache）
 * @returns {Promise<{path:string, ext:string}>} 實際格式依檔頭判斷
 */
export async function downloadCover(galleryId, meta, cachePath) {
  return schedule(async () => {
    const url = fillTemplate(endpoint('endpoint_cover'), { media_id: meta.mediaId, ext: meta.coverExt })
    assertAllowed(url)
    let lastErr
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt) await sleep(MIN_INTERVAL)
        await Promise.race([
          Filesystem.downloadFile({
            url,
            path: cachePath,
            directory: Directory.Cache,
            recursive: true,
            connectTimeout: COVER_TIMEOUT,
            readTimeout: COVER_TIMEOUT,
          }),
          sleep(COVER_TIMEOUT + 2000).then(() => {
            throw new AppError(E.TIMEOUT)
          }),
        ])
        const st = await Filesystem.stat({ path: cachePath, directory: Directory.Cache })
        if (!st.size || st.size > MAX_COVER_BYTES) throw new AppError(E.COVER_FAILED, { reason: 'size' })
        const file = await Filesystem.readFile({ path: cachePath, directory: Directory.Cache })
        const ext = sniffImageExt(typeof file.data === 'string' ? file.data : new Uint8Array(await file.data.arrayBuffer()))
        if (!ext) throw new AppError(E.COVER_FAILED, { reason: 'not image' })
        log({ gallery_id: galleryId, kind: 'cover', http_status: 200, error_code: null })
        return { path: cachePath, ext }
      } catch (err) {
        lastErr = err instanceof AppError ? err : classifyNetworkError(err)
        if (lastErr.code !== E.TIMEOUT) break
      }
    }
    await Filesystem.deleteFile({ path: cachePath, directory: Directory.Cache }).catch(() => {})
    log({ gallery_id: galleryId, kind: 'cover', http_status: null, error_code: lastErr.code })
    throw new AppError(E.COVER_FAILED, { cause: lastErr.code })
  })
}
