// 轉接層：所有對 nhentai 的請求與解析都集中在這裡，對內只輸出固定的 BookMeta。
// 站方改版時只需要修改這個檔（或在設定頁「進階」修改端點範本）。
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { NhWebFetch } from 'nh-webfetch'
import { AppError, E } from './errors.js'
import {
  buildCdnUrl,
  fillTemplate,
  hostOf,
  isApiRetired,
  isChallengePage,
  normalizeCdnServer,
  parseCdnConfig,
  parseGallery,
  sniffImageExt,
} from './parse.js'
import { settings, DEFAULT_ENDPOINTS } from './settings.js'

const DETAIL_TIMEOUT = 10_000
const WEBVIEW_TIMEOUT = 20_000 // 不含原生端等待 challenge 自動通過的 15 秒
const CHALLENGE_URL = 'https://nhentai.net/'
const COVER_TIMEOUT = 20_000
// 全局節流：同時只 1 個請求、間隔至少 3 秒（API v2 詳情匿名上限 20 次／分鐘／IP）
const MIN_INTERVAL = 3_000
const MAX_COVER_BYTES = 5 * 1024 * 1024
const CDN_CACHE_TTL = 24 * 60 * 60 * 1000
export const RAW_FORMAT = 'api-v2'
const PROJECT_URL = 'https://github.com/anson669989/NH-Shelfie'

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

let logger = null
/** 由服務層注入抓取紀錄函式 (entry) => Promise */
export function setFetchLogger(fn) {
  logger = fn
}
let settingWriter = null
/** 由服務層注入設定持久化函式 (key, value) => Promise；本檔不直接碰資料庫 */
export function setSettingWriter(fn) {
  settingWriter = fn
}
function persist(key, value) {
  settings[key] = value
  try {
    Promise.resolve(settingWriter?.(key, value)).catch(() => {})
  } catch {
    /* 持久化失敗不影響主流程 */
  }
}
function rememberMode(via) {
  if (settings.last_fetch_ok !== via) persist('last_fetch_ok', via)
}

// ---------- User-Agent（站方要求具描述性：AppName/version (contact or project URL)）----------
let uaPromise = null
function appUserAgent() {
  uaPromise ??= CapApp.getInfo()
    .then((i) => i?.version || '0')
    .catch(() => '0')
    .then((v) => `NH-Shelfie/${v} (+${PROJECT_URL})`)
  return uaPromise
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

// ---------- 診斷（任務 003）----------
// 最近一次 fetchDetail 的嘗試紀錄，只存記憶體；開發者模式的「測試連線」顯示並可複製。
const TRACE_TEXT_CHARS = 300
let lastTrace = null

/** 回應開頭若干字，一律轉成純文字字串 */
function bodyHead(data) {
  if (data == null) return ''
  let s
  if (typeof data === 'string') s = data
  else {
    try {
      s = JSON.stringify(data)
    } catch {
      s = String(data)
    }
  }
  return s.slice(0, TRACE_TEXT_CHARS)
}

// 外掛回傳的診斷欄位（NhWebFetchPlugin.diag）；只挑已知欄位
const PLUGIN_DIAG_KEYS = [
  'href',
  'title',
  'stage',
  'reloaded',
  'probeHref',
  'probeTitle',
  'readyTitle',
  'mainFrameError',
  'webMessageListener',
  'webViewVersion',
  'status',
  'contentType',
  'bodyHead',
]
function pickPluginDiag(obj, skip = []) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const k of PLUGIN_DIAG_KEYS) {
    if (skip.includes(k) || obj[k] === undefined || obj[k] === null) continue
    out[k] = typeof obj[k] === 'string' ? obj[k].slice(0, TRACE_TEXT_CHARS) : obj[k]
  }
  return out
}

/** @returns {object|null} 最近一次 fetchDetail 的診斷紀錄（複本） */
export function getLastDetailTrace() {
  return lastTrace ? JSON.parse(JSON.stringify(lastTrace)) : null
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

/**
 * 原生與 WebView 兩條路共用的回應判斷。回傳解析後的 JSON 物件，否則丟對應的 AppError。
 * @param {{status:number, contentType:string, data:any, retryAfter?:string}} res
 */
function interpretDetail({ status, contentType, data, retryAfter }) {
  if (status === 404) throw new AppError(E.NOT_FOUND, { httpStatus: status })
  if (status === 429) {
    const ra = Number.parseInt(retryAfter || '', 10)
    const sec = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 600) : 30
    blockedUntil = Date.now() + sec * 1000
    throw new AppError(E.RATE_LIMITED, { httpStatus: status, retryAfter: sec })
  }
  if (isApiRetired({ status, body: typeof data === 'string' ? data : '' })) {
    // 舊 API 停用（403 text/plain「Use new API」）：是格式問題，不是被 Cloudflare 擋
    throw new AppError(E.BAD_FORMAT, { httpStatus: status, reason: 'api retired' })
  }
  if (typeof data === 'string' && isChallengePage({ status, contentType, body: data })) {
    throw new AppError(E.BLOCKED, { httpStatus: status })
  }
  let json = data
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json)
    } catch {
      json = null
    }
  }
  if (status === 403 || status === 503 || /text\/html/i.test(contentType || '') || json == null) {
    throw new AppError(E.BLOCKED, { httpStatus: status })
  }
  if (status < 200 || status >= 300) throw new AppError(E.BLOCKED, { httpStatus: status })
  return json
}

/** 把 NhWebFetch 外掛的錯誤碼轉成 AppError */
function mapWebFetchError(err) {
  const code = String(err?.code || '')
  const extra = { pluginCode: code || null, cause: String(err?.message || err || '') }
  let mapped
  if (code === 'CHALLENGE_REQUIRED') mapped = new AppError(E.CHALLENGE, extra)
  else if (code === 'TIMEOUT') mapped = new AppError(E.TIMEOUT, extra)
  else if (code === 'NETWORK') mapped = Object.assign(classifyNetworkError(err), extra)
  else if (code === 'INVALID_URL') mapped = new AppError(E.ENDPOINT_INVALID, extra)
  // UNSUPPORTED（WebView 太舊）、UNIMPLEMENTED（外掛未註冊／非 Android）、BUSY 等：保留原始 code
  else mapped = new AppError(E.BLOCKED, extra)
  const d = pickPluginDiag(err?.data)
  if (Object.keys(d).length) mapped.pluginDiag = d
  return mapped
}

async function requestWebView(url, step) {
  assertAllowed(url)
  let res
  try {
    res = await NhWebFetch.fetchText({ url, timeoutMs: WEBVIEW_TIMEOUT })
  } catch (err) {
    throw mapWebFetchError(err)
  }
  Object.assign(step, {
    status: res.status,
    contentType: res.contentType || '',
    bodyHead: bodyHead(res.body),
    plugin: pickPluginDiag(res, ['status', 'contentType', 'bodyHead']),
  })
  const data = interpretDetail({ status: res.status, contentType: res.contentType, data: res.body })
  return { data, status: res.status }
}

async function requestNative(url, useMobileUa, step) {
  assertAllowed(url)
  let res
  try {
    res = await CapacitorHttp.get({
      url,
      headers: { Accept: 'application/json', 'User-Agent': useMobileUa ? MOBILE_UA : await appUserAgent() },
      connectTimeout: DETAIL_TIMEOUT,
      readTimeout: DETAIL_TIMEOUT,
      responseType: 'json',
    })
  } catch (err) {
    throw Object.assign(classifyNetworkError(err), { cause: String(err?.message || err || '') })
  }
  Object.assign(step, {
    status: res.status,
    contentType: header(res, 'content-type'),
    bodyHead: bodyHead(res.data),
  })
  const data = interpretDetail({
    status: res.status,
    contentType: header(res, 'content-type'),
    data: res.data,
    retryAfter: header(res, 'retry-after'),
  })
  return { data, status: res.status }
}

// 這次 App 執行期間原生請求是否已被 Cloudflare 擋過；auto 模式據此直接走 WebView
let nativeBlocked = false

/** 依 fetch_mode 決定嘗試順序。onlyIf：只有上一步是該錯誤碼才嘗試。 */
function detailAttempts() {
  const mode = settings.fetch_mode
  if (mode === 'native') {
    return [
      { via: 'native', ua: false },
      { via: 'native', ua: false, onlyIf: E.TIMEOUT },
      { via: 'native', ua: true, onlyIf: E.BLOCKED },
    ]
  }
  if (mode === 'webview' || settings.last_fetch_ok === 'webview' || nativeBlocked) {
    return [{ via: 'webview' }]
  }
  return [
    { via: 'native', ua: false },
    { via: 'native', ua: false, onlyIf: E.TIMEOUT },
    { via: 'webview', onlyIf: E.BLOCKED },
  ]
}

/**
 * 取得詳情並解析。
 * - auto（預設）：原生請求；逾時重試 1 次；被擋（403/503/HTML）改用 WebView 驗證抓取
 * - native：原生請求；被擋時帶手機 User-Agent 重試 1 次
 * - webview：只用 WebView
 * WebView 卡在 Cloudflare 驗證時丟 E.CHALLENGE，介面可呼叫 showChallenge() 讓使用者手動通過。
 * @returns {Promise<{meta: object, rawJson: string, rawFormat: string}>}
 */
export async function fetchDetail(id) {
  id = Math.trunc(Number(id))
  return schedule(async () => {
    let lastErr
    let via = 'native'
    const trace = {
      galleryId: id,
      at: new Date().toISOString(),
      fetchMode: settings.fetch_mode || 'auto',
      lastFetchOk: settings.last_fetch_ok || '',
      nativeBlocked,
      platform: Capacitor.getPlatform(),
      pluginAvailable: Capacitor.isPluginAvailable('NhWebFetch'),
      attempts: [],
      result: null,
    }
    lastTrace = trace
    for (const attempt of detailAttempts()) {
      if (attempt.onlyIf && lastErr?.code !== attempt.onlyIf) continue
      if (lastErr) await sleep(MIN_INTERVAL)
      via = attempt.via
      const step = via === 'native' ? { via, ua: !!attempt.ua } : { via }
      const startedAt = Date.now()
      trace.attempts.push(step)
      try {
        const url = fillTemplate(endpoint('endpoint_detail'), { id })
        const { data, status } =
          via === 'webview' ? await requestWebView(url, step) : await requestNative(url, attempt.ua, step)
        step.ms = Date.now() - startedAt
        const meta = parseGallery(data, RAW_FORMAT)
        step.ok = true
        trace.result = 'ok'
        if (settings.fetch_mode === 'auto' || !settings.fetch_mode) rememberMode(via)
        log({ gallery_id: id, kind: logKind(via), http_status: status, error_code: null })
        return { meta: { ...meta, galleryId: id }, rawJson: JSON.stringify(data), rawFormat: RAW_FORMAT }
      } catch (err) {
        lastErr = err instanceof AppError ? err : classifyNetworkError(err)
        step.ms ??= Date.now() - startedAt
        step.error = lastErr.code
        if (step.status == null && lastErr.httpStatus != null) step.status = lastErr.httpStatus
        if (lastErr.pluginCode) step.pluginCode = lastErr.pluginCode
        const msg = err instanceof AppError ? lastErr.cause : err?.message || err
        if (msg) step.message = String(msg).slice(0, TRACE_TEXT_CHARS)
        if (lastErr.pluginDiag) step.plugin = lastErr.pluginDiag
        if (via === 'native' && lastErr.code === E.BLOCKED) nativeBlocked = true
        if ([E.BAD_FORMAT, E.NOT_FOUND, E.RATE_LIMITED, E.CHALLENGE].includes(lastErr.code)) break
      }
    }
    trace.result = lastErr.code
    log({ gallery_id: id, kind: logKind(via), http_status: lastErr.httpStatus ?? null, error_code: lastErr.code })
    throw lastErr
  })
}

function logKind(via) {
  return via === 'webview' ? 'detail-webview' : 'detail'
}

// ---------- Cloudflare 驗證 ----------
/**
 * 顯示可互動的驗證畫面（全螢幕），使用者通過或關閉後回傳是否通過。
 * 會載入站方頁面，所以一樣經過 schedule() 節流。
 * @param {{title:string, closeLabel:string}} labels 介面字串由 i18n 提供
 * @returns {Promise<boolean>}
 */
export async function showChallenge(labels = {}) {
  return schedule(async () => {
    try {
      const r = await NhWebFetch.showChallenge({ url: CHALLENGE_URL, ...labels })
      const passed = !!r?.passed
      if (passed) nativeBlocked = true // 驗證過的 cookie 只存在 WebView，之後直接走 WebView
      return passed
    } catch (err) {
      throw mapWebFetchError(err)
    }
  })
}

/** 清除 nhentai 網域的 cookie 與 WebView 狀態（設定頁「重設驗證」）。不對站方發請求。 */
export async function clearSession() {
  try {
    await NhWebFetch.clearSession()
  } catch (err) {
    throw mapWebFetchError(err)
  }
  nativeBlocked = false
}

// ---------- CDN 伺服器清單 ----------
function readCdnCache() {
  try {
    const c = JSON.parse(settings.cdn_cache || 'null')
    if (!c || c.src !== endpoint('endpoint_cdn') || !Array.isArray(c.servers)) return null
    const servers = c.servers.map(normalizeCdnServer).filter(Boolean)
    return servers.length ? { at: Number(c.at) || 0, servers } : null
  } catch {
    return null
  }
}

function errCode(err) {
  return err instanceof AppError ? err.code : null
}

let cdnInflight = null
/**
 * 取得封面（縮圖）伺服器清單（GET endpoint_cdn）。快取在 settings.cdn_cache，24 小時內不重抓；
 * 抓取失敗時沿用過期的快取。
 * @returns {Promise<string[]>}
 */
export async function getThumbServers() {
  const cached = readCdnCache()
  if (cached && Date.now() - cached.at < CDN_CACHE_TTL) return cached.servers
  cdnInflight ??= schedule(async () => {
    const url = endpoint('endpoint_cdn')
    const order = settings.fetch_mode === 'webview' || nativeBlocked ? ['webview'] : ['native', 'webview']
    let lastErr
    for (const via of order) {
      const step = {}
      try {
        if (lastErr) await sleep(MIN_INTERVAL)
        const { data, status } = via === 'webview' ? await requestWebView(url, step) : await requestNative(url, false, step)
        const { thumbServers } = parseCdnConfig(data)
        persist('cdn_cache', JSON.stringify({ src: url, at: Date.now(), servers: thumbServers }))
        log({ gallery_id: null, kind: 'cdn', http_status: status, error_code: null })
        return thumbServers
      } catch (err) {
        lastErr = err instanceof AppError ? err : classifyNetworkError(err)
        if (lastErr.code !== E.BLOCKED) break // 只有被擋才改走 WebView
      }
    }
    log({ gallery_id: null, kind: 'cdn', http_status: lastErr.httpStatus ?? null, error_code: lastErr.code })
    throw lastErr
  }).finally(() => {
    cdnInflight = null
  })
  try {
    return await cdnInflight
  } catch (err) {
    if (cached && errCode(err) !== E.RATE_LIMITED) return cached.servers
    throw err
  }
}

// ---------- 封面 ----------
// 最近一次 downloadCover 的逐次嘗試紀錄，只存記憶體；「測試連線」的診斷顯示
let lastCoverTrace = null
/** @returns {object|null} 最近一次 downloadCover 的診斷紀錄（複本） */
export function getLastCoverTrace() {
  return lastCoverTrace ? JSON.parse(JSON.stringify(lastCoverTrace)) : null
}

/** 外掛丟出的原始錯誤 → 純文字欄位（不推測原因） */
function rawErrorInfo(err) {
  const out = {}
  if (err == null) return out
  const msg = err.message ?? err.errorMessage ?? (typeof err === 'string' ? err : '')
  if (msg) out.message = String(msg).slice(0, TRACE_TEXT_CHARS)
  if (err.code != null) out.pluginCode = String(err.code)
  if (err.data != null) out.data = bodyHead(err.data)
  const m = String(msg).match(/\b([1-5]\d\d)\b/)
  if (m) out.statusInMessage = Number(m[1])
  return out
}

/** 診斷用：對同一網址發 HEAD，取回真正的 HTTP 狀態碼（呼叫端負責間隔）。 */
async function probeHead(url, ua) {
  const startedAt = Date.now()
  try {
    const res = await CapacitorHttp.request({
      method: 'HEAD',
      url,
      headers: { 'User-Agent': ua },
      connectTimeout: DETAIL_TIMEOUT,
      readTimeout: DETAIL_TIMEOUT,
    })
    return {
      status: res.status,
      contentType: header(res, 'content-type'),
      contentLength: header(res, 'content-length'),
      server: header(res, 'server'),
      ms: Date.now() - startedAt,
    }
  } catch (err) {
    return { error: true, ...rawErrorInfo(err), ms: Date.now() - startedAt }
  }
}

/**
 * 以原生下載把封面存到快取目錄（不經 base64 橋接），並驗證檔頭與大小。
 * 網址＝CDN 縮圖伺服器 + meta.coverPath（原樣使用，不猜副檔名）。
 * 失敗就依 /api/v2/cdn 的順序換下一台伺服器，直到全部試過；每次之間至少 MIN_INTERVAL。
 * CDN 回 429 視為退避訊號，立即停止。
 * @param {{coverPath:string}} meta
 * @param {string} cachePath 例如 preview/123456.tmp（相對於 Directory.Cache）
 * @param {{diagnose?:boolean}} [opts] diagnose：下載失敗後再發一次 HEAD 取得 HTTP 狀態碼（只給「測試連線」用）
 * @returns {Promise<{path:string, ext:string, url:string}>} 實際格式依檔頭判斷
 */
export async function downloadCover(galleryId, meta, cachePath, { diagnose = false } = {}) {
  const trace = { galleryId, coverPath: meta?.coverPath ?? null, servers: [], attempts: [], result: null }
  lastCoverTrace = trace
  if (!meta?.coverPath) {
    trace.result = E.BAD_FORMAT
    throw new AppError(E.COVER_FAILED, { cause: E.BAD_FORMAT })
  }
  let servers
  try {
    servers = await getThumbServers() // 自己會經 schedule()，不可在下方的 schedule 內呼叫（會互等）
  } catch (err) {
    trace.result = `cdn:${errCode(err) || E.UNKNOWN}`
    if (errCode(err) === E.RATE_LIMITED) throw err
    throw new AppError(E.COVER_FAILED, { cause: errCode(err) || E.UNKNOWN })
  }
  trace.servers = [...servers]
  const ua = await appUserAgent()
  trace.userAgent = ua
  return schedule(async () => {
    let lastErr
    let url = ''
    for (let i = 0; i < servers.length; i++) {
      const step = { host: null, url: null, uaSent: true }
      trace.attempts.push(step)
      const startedAt = Date.now()
      try {
        if (i) await sleep(MIN_INTERVAL)
        url = buildCdnUrl(servers[i], meta.coverPath)
        assertAllowed(url)
        step.url = url
        step.host = new URL(url).hostname
        await Promise.race([
          Filesystem.downloadFile({
            url,
            path: cachePath,
            directory: Directory.Cache,
            recursive: true,
            headers: { 'User-Agent': ua },
            connectTimeout: COVER_TIMEOUT,
            readTimeout: COVER_TIMEOUT,
          }),
          sleep(COVER_TIMEOUT + 2000).then(() => {
            throw new AppError(E.TIMEOUT)
          }),
        ])
        const st = await Filesystem.stat({ path: cachePath, directory: Directory.Cache })
        step.bytes = st.size ?? null
        if (!st.size || st.size > MAX_COVER_BYTES) throw new AppError(E.COVER_FAILED, { reason: 'size' })
        const file = await Filesystem.readFile({ path: cachePath, directory: Directory.Cache })
        const ext = sniffImageExt(typeof file.data === 'string' ? file.data : new Uint8Array(await file.data.arrayBuffer()))
        if (!ext) throw new AppError(E.COVER_FAILED, { reason: 'not image' })
        step.ok = true
        step.ext = ext
        step.ms = Date.now() - startedAt
        trace.result = 'ok'
        log({ gallery_id: galleryId, kind: 'cover', http_status: 200, error_code: null })
        return { path: cachePath, ext, url }
      } catch (err) {
        step.ms = Date.now() - startedAt
        Object.assign(step, rawErrorInfo(err))
        if (err instanceof AppError) {
          lastErr = err
          if (err.reason) step.reason = err.reason
        } else if (/\b429\b|Too Many Requests/i.test(String(err?.message || err))) {
          blockedUntil = Date.now() + 30_000
          lastErr = new AppError(E.RATE_LIMITED, { httpStatus: 429, retryAfter: 30 })
        } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          lastErr = new AppError(E.OFFLINE)
        } else {
          // 不再一律歸成 OFFLINE：原始訊息已記在 step.message / pluginCode
          lastErr = new AppError(E.COVER_FAILED, { reason: 'download' })
        }
        step.error = lastErr.code
        await Filesystem.deleteFile({ path: cachePath, directory: Directory.Cache }).catch(() => {})
        if (lastErr.code === E.RATE_LIMITED) break
        if (diagnose && step.url) {
          await sleep(MIN_INTERVAL)
          step.probe = await probeHead(step.url, ua)
          if (step.probe.status === 429) {
            blockedUntil = Date.now() + 30_000
            lastErr = new AppError(E.RATE_LIMITED, { httpStatus: 429, retryAfter: 30 })
            break
          }
        }
      }
    }
    trace.result = lastErr.code
    log({ gallery_id: galleryId, kind: 'cover', http_status: lastErr.httpStatus ?? null, error_code: lastErr.code })
    if (lastErr.code === E.RATE_LIMITED) throw lastErr
    throw new AppError(E.COVER_FAILED, { cause: lastErr.code, url })
  })
}
