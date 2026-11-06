// 轉接層：所有對 nhentai 的請求與解析都集中在這裡，對內只輸出固定的 BookMeta。
// 站方改版時只需要修改這個檔（或在設定頁「進階」修改端點範本）。
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { NhWebFetch } from 'nh-webfetch'
import { AppError, E } from './errors.js'
import { fillTemplate, hostOf, isChallengePage, parseGallery, sniffImageExt } from './parse.js'
import { settings, DEFAULT_ENDPOINTS } from './settings.js'

const DETAIL_TIMEOUT = 10_000
const WEBVIEW_TIMEOUT = 20_000 // 不含原生端等待 challenge 自動通過的 15 秒
const CHALLENGE_URL = 'https://nhentai.net/'
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
let modeRecorder = null
/** 由服務層注入：auto 模式成功方式改變時持久化 (mode: 'native'|'webview') => Promise */
export function setModeRecorder(fn) {
  modeRecorder = fn
}
function rememberMode(via) {
  if (settings.last_fetch_ok === via) return
  settings.last_fetch_ok = via
  try {
    Promise.resolve(modeRecorder?.(via)).catch(() => {})
  } catch {
    /* 持久化失敗不影響主流程 */
  }
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

async function requestDetailWebView(id, step) {
  const url = fillTemplate(endpoint('endpoint_detail'), { id })
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

async function requestDetailNative(id, useMobileUa, step) {
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
        const { data, status } =
          via === 'webview' ? await requestDetailWebView(id, step) : await requestDetailNative(id, attempt.ua, step)
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
