// A5：封面下載相關的純函式與設定遷移。
import { describe, it, expect } from 'vitest'
import { classifyDownloadError, orderServers } from '../src/services/parse.js'
import { planSettingsMigration } from '../src/services/settingsMigration.js'

// dev.10 實機診斷：t1–t4 四台都是這個訊息，HEAD probe 四台都是 200 image/jpeg
const DEV10_MESSAGE =
  'Error downloading file: /data/user/0/io.github.anson669989.nhshelfie/cache/test/228922.tmp: open failed: ENOENT (No such file or directory)'

describe('classifyDownloadError', () => {
  it('dev.10 的 ENOENT 訊息是寫檔失敗，不是離線', () => {
    expect(classifyDownloadError({ message: DEV10_MESSAGE })).toBe('WRITE_FAILED')
    expect(classifyDownloadError(new Error(DEV10_MESSAGE), { online: true })).toBe('WRITE_FAILED')
    // 即使系統回報離線，檔案錯誤仍以寫檔失敗為準
    expect(classifyDownloadError({ message: DEV10_MESSAGE }, { online: false })).toBe('WRITE_FAILED')
  })
  it('其他寫檔類錯誤', () => {
    for (const msg of [
      'open failed: EACCES (Permission denied)',
      'open failed: EROFS (Read-only file system)',
      'java.io.FileNotFoundException: /x/y.tmp',
    ]) {
      expect(classifyDownloadError({ message: msg })).toBe('WRITE_FAILED')
    }
  })
  it('空間不足', () => {
    expect(classifyDownloadError({ message: 'write failed: ENOSPC (No space left on device)' })).toBe('STORAGE_FULL')
  })
  it('真正的網路錯誤才是 OFFLINE', () => {
    expect(classifyDownloadError({ message: 'Unable to resolve host "t1.nhentai.net"' })).toBe('OFFLINE')
    expect(classifyDownloadError({ message: 'Failed to connect to t1.nhentai.net/1.2.3.4:443' })).toBe('OFFLINE')
    expect(classifyDownloadError({ message: 'anything' }, { online: false })).toBe('OFFLINE')
  })
  it('逾時與限速', () => {
    expect(classifyDownloadError({ message: 'java.net.SocketTimeoutException: timeout' })).toBe('TIMEOUT')
    expect(classifyDownloadError({ message: 'HTTP 429 Too Many Requests' })).toBe('RATE_LIMITED')
  })
  it('認不出來的訊息不再歸成 OFFLINE', () => {
    expect(classifyDownloadError({ message: 'Something odd happened' })).toBe('COVER_FAILED')
    expect(classifyDownloadError(undefined)).toBe('COVER_FAILED')
  })
})

describe('orderServers（主機輪替順序）', () => {
  const list = ['https://t1.nhentai.net', 'https://t2.nhentai.net', 'https://t3.nhentai.net', 'https://t4.nhentai.net']
  it('沒有記錄時照 /api/v2/cdn 的順序（t1 優先）', () => {
    expect(orderServers(list, '')).toEqual(list)
  })
  it('上次成功的主機排第一，其餘維持原順序', () => {
    expect(orderServers(list, 'https://t3.nhentai.net')).toEqual([
      'https://t3.nhentai.net',
      'https://t1.nhentai.net',
      'https://t2.nhentai.net',
      'https://t4.nhentai.net',
    ])
  })
  it('記錄的主機已不在清單內、或不合法 → 忽略', () => {
    expect(orderServers(list, 'https://t9.nhentai.net')).toEqual(list)
    expect(orderServers(list, 'https://evil.example')).toEqual(list)
  })
})

describe('planSettingsMigration（設定遷移）', () => {
  const DEFAULTS = {
    test_id: '228922',
    endpoint_detail: 'https://nhentai.net/api/v2/galleries/{id}',
    last_fetch_ok: '',
    settings_rev: '0',
  }
  it('舊預設 test_id 177013 → 228922', () => {
    const { set } = planSettingsMigration({ ...DEFAULTS, test_id: '177013' }, DEFAULTS)
    expect(set.test_id).toBe('228922')
  })
  it('舊詳情端點換成 v2；使用者自訂的值不動', () => {
    const old = planSettingsMigration({ ...DEFAULTS, endpoint_detail: 'https://nhentai.net/api/gallery/{id}' }, DEFAULTS)
    expect(old.set.endpoint_detail).toBe(DEFAULTS.endpoint_detail)
    const custom = planSettingsMigration({ ...DEFAULTS, test_id: '123', settings_rev: '1' }, DEFAULTS)
    expect(custom.set).toEqual({})
  })
  it('第一次遷移清掉被誤判的 last_fetch_ok=webview，之後不再動', () => {
    const first = planSettingsMigration({ ...DEFAULTS, last_fetch_ok: 'webview' }, DEFAULTS)
    expect(first.set).toMatchObject({ last_fetch_ok: '', settings_rev: '1' })
    const later = planSettingsMigration({ ...DEFAULTS, last_fetch_ok: 'webview', settings_rev: '1' }, DEFAULTS)
    expect(later.set).toEqual({})
  })
  it('刪除廢除的 endpoint_cover', () => {
    expect(planSettingsMigration(DEFAULTS, DEFAULTS).remove).toContain('endpoint_cover')
  })
})
