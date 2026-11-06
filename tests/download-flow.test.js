// A5：downloadCover 的實際流程（Capacitor 外掛以假的檔案系統取代，不需要手機）。
// 涵蓋：資料夾不存在、資料夾已存在、寫檔失敗、主機輪替與記住上次成功的主機、3 秒間隔。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SERVERS = ['https://t1.nhentai.net', 'https://t2.nhentai.net', 'https://t3.nhentai.net', 'https://t4.nhentai.net']
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5])
const DEV10_MESSAGE =
  'Error downloading file: /data/user/0/io.github.anson669989.nhshelfie/cache/test/228922.tmp: open failed: ENOENT (No such file or directory)'

// ---- 假的檔案系統：行為和 dev.10 實機一致（downloadFile 不會自己建立上層資料夾）----
const fsState = {
  dirs: new Set(),
  files: new Map(),
  failHosts: new Set(), // 這些主機連線失敗
  mkdirError: null, // mkdir 要丟的錯誤
  downloadError: null, // downloadFile 一律丟這個錯誤
  calls: [], // { op, path, url, at }
}
const key = (directory, path) => `${directory}:${path}`
const parentOf = (path) => path.split('/').slice(0, -1).join('/')

const Filesystem = {
  async mkdir({ path, directory }) {
    fsState.calls.push({ op: 'mkdir', path, at: Date.now() })
    if (fsState.mkdirError) throw new Error(fsState.mkdirError)
    if (fsState.dirs.has(key(directory, path))) throw new Error('Directory exists')
    fsState.dirs.add(key(directory, path))
  },
  async downloadFile({ url, path, directory, headers }) {
    fsState.calls.push({ op: 'download', path, url, ua: headers?.['User-Agent'], at: Date.now() })
    if (fsState.downloadError) throw new Error(fsState.downloadError)
    if (fsState.failHosts.has(new URL(url).origin)) throw new Error(`Failed to connect to ${new URL(url).hostname}`)
    const parent = parentOf(path)
    if (parent && !fsState.dirs.has(key(directory, parent))) {
      throw new Error(`Error downloading file: /cache/${path}: open failed: ENOENT (No such file or directory)`)
    }
    fsState.files.set(key(directory, path), JPEG)
    return { path }
  },
  async stat({ path, directory }) {
    const f = fsState.files.get(key(directory, path))
    if (!f) throw new Error('File does not exist')
    return { size: f.length }
  },
  async readFile({ path, directory }) {
    return { data: fsState.files.get(key(directory, path)).toString('base64') }
  },
  async deleteFile({ path, directory }) {
    fsState.files.delete(key(directory, path))
  },
}

const settings = {}
vi.mock('@capacitor/filesystem', () => ({ Filesystem, Directory: { Cache: 'CACHE', Data: 'DATA' } }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android', isPluginAvailable: () => true },
  CapacitorHttp: { get: vi.fn(), request: vi.fn(async () => ({ status: 200, headers: {} })) },
}))
vi.mock('@capacitor/app', () => ({ App: { getInfo: async () => ({ version: '0.1.1' }) } }))
vi.mock('nh-webfetch', () => ({ NhWebFetch: {} }))
vi.mock('../src/services/settings.js', () => ({
  settings,
  DEFAULT_ENDPOINTS: {
    endpoint_detail: 'https://nhentai.net/api/v2/galleries/{id}',
    endpoint_cdn: 'https://nhentai.net/api/v2/cdn',
    endpoint_page: 'https://nhentai.net/g/{id}/',
  },
}))

const META = { coverPath: 'galleries/1205270/cover.jpg' }

/** 推進假時鐘直到 promise 結束（downloadCover 內有 3 秒間隔） */
async function settle(promise) {
  let done = false
  let value
  let error
  promise.then(
    (v) => ((done = true), (value = v)),
    (e) => ((done = true), (error = e)),
  )
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(500)
  if (!done) throw new Error('promise did not settle')
  if (error) throw error
  return value
}

let nh
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'))
  fsState.dirs.clear()
  fsState.files.clear()
  fsState.failHosts.clear()
  fsState.mkdirError = null
  fsState.downloadError = null
  fsState.calls.length = 0
  for (const k of Object.keys(settings)) delete settings[k]
  Object.assign(settings, {
    fetch_mode: 'auto',
    endpoint_cdn: 'https://nhentai.net/api/v2/cdn',
    cdn_last_host: '',
    cdn_cache: JSON.stringify({ src: 'https://nhentai.net/api/v2/cdn', at: Date.now(), servers: SERVERS }),
  })
  vi.resetModules()
  nh = await import('../src/services/nhSource.js')
})
afterEach(() => {
  vi.useRealTimers()
})

describe('downloadCover', () => {
  it('資料夾不存在：先 mkdir 再下載，成功（dev.10 的情境）', async () => {
    const res = await settle(nh.downloadCover(228922, META, 'test/228922.tmp'))
    expect(res.ext).toBe('jpg')
    expect(res.url).toBe('https://t1.nhentai.net/galleries/1205270/cover.jpg')
    expect(res.path).toBe('test/228922.tmp.0')
    const ops = fsState.calls.map((c) => c.op)
    expect(ops.indexOf('mkdir')).toBeLessThan(ops.indexOf('download'))
    expect(fsState.calls.find((c) => c.op === 'mkdir').path).toBe('test')
    expect(fsState.calls.find((c) => c.op === 'download').ua).toMatch(/^NH-Shelfie\/0\.1\.1 \(\+https:\/\/github\.com\//)
  })

  it('資料夾已存在：略過 mkdir 的「已存在」錯誤，照常下載', async () => {
    fsState.dirs.add('CACHE:preview')
    const res = await settle(nh.downloadCover(1, META, 'preview/1.tmp'))
    expect(res.ext).toBe('jpg')
  })

  it('建資料夾失敗 → WRITE_FAILED，不發下載請求', async () => {
    fsState.mkdirError = 'mkdir failed: EACCES (Permission denied)'
    await expect(settle(nh.downloadCover(1, META, 'test/1.tmp'))).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(fsState.calls.some((c) => c.op === 'download')).toBe(false)
  })

  it('寫檔失敗（dev.10 訊息）→ WRITE_FAILED、不是 OFFLINE，且不換主機（只試 1 次）', async () => {
    fsState.downloadError = DEV10_MESSAGE
    await expect(settle(nh.downloadCover(228922, META, 'test/228922.tmp'))).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(fsState.calls.filter((c) => c.op === 'download')).toHaveLength(1)
    const trace = nh.getLastCoverTrace()
    expect(trace.result).toBe('WRITE_FAILED')
    expect(trace.attempts[0].message).toContain('ENOENT')
  })

  it('主機輪替：t1、t2 連不上 → t3 成功；每次間隔 ≥ 3 秒；記住 t3，下次先用 t3', async () => {
    fsState.failHosts.add('https://t1.nhentai.net')
    fsState.failHosts.add('https://t2.nhentai.net')
    const res = await settle(nh.downloadCover(1, META, 'preview/1.tmp'))
    expect(res.url.startsWith('https://t3.nhentai.net/')).toBe(true)
    const downloads = fsState.calls.filter((c) => c.op === 'download')
    expect(downloads.map((c) => new URL(c.url).hostname)).toEqual(['t1.nhentai.net', 't2.nhentai.net', 't3.nhentai.net'])
    for (let i = 1; i < downloads.length; i++) expect(downloads[i].at - downloads[i - 1].at).toBeGreaterThanOrEqual(3000)
    expect(settings.cdn_last_host).toBe('https://t3.nhentai.net')
    expect(nh.getLastCoverTrace().attempts.map((a) => a.error ?? 'ok')).toEqual(['OFFLINE', 'OFFLINE', 'ok'])

    fsState.failHosts.clear()
    fsState.calls.length = 0
    const again = await settle(nh.downloadCover(2, META, 'preview/2.tmp'))
    expect(new URL(again.url).hostname).toBe('t3.nhentai.net')
    expect(fsState.calls.filter((c) => c.op === 'download')).toHaveLength(1)
  })

  it('四台都連不上 → 依序試完 t1–t4，丟出可說明原因的錯誤碼', async () => {
    for (const s of SERVERS) fsState.failHosts.add(s)
    await expect(settle(nh.downloadCover(1, META, 'preview/1.tmp'))).rejects.toMatchObject({ code: 'OFFLINE' })
    expect(fsState.calls.filter((c) => c.op === 'download').map((c) => new URL(c.url).hostname)).toEqual([
      't1.nhentai.net',
      't2.nhentai.net',
      't3.nhentai.net',
      't4.nhentai.net',
    ])
  })

  it('下載前的請求間隔：連續兩次 downloadCover 也至少相隔 3 秒', async () => {
    await settle(nh.downloadCover(1, META, 'preview/1.tmp'))
    await settle(nh.downloadCover(2, META, 'preview/2.tmp'))
    const d = fsState.calls.filter((c) => c.op === 'download')
    expect(d[1].at - d[0].at).toBeGreaterThanOrEqual(3000)
  })
})
