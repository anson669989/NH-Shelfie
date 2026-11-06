import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  parseGallery,
  parseCoverPath,
  parseCdnConfig,
  normalizeCdnServer,
  buildCdnUrl,
  isApiRetired,
  isChallengePage,
} from '../src/services/parse.js'

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const jpg = load('gallery-api-v2.json') // 228922，真實回應
const webp = load('gallery-api-v2-webp.json') // 694445，真實回應（cover.jpg.webp）

describe("parseGallery(..., 'api-v2')", () => {
  it('解析真實回應（jpg）', () => {
    const m = parseGallery(jpg, 'api-v2')
    expect(m.galleryId).toBe(228922)
    expect(m.mediaId).toBe('1205270')
    expect(m.coverPath).toBe('galleries/1205270/cover.jpg')
    expect(m.coverExt).toBe('jpg')
    expect(m.title).toBe('EROGROS Vol. 2')
    expect(m.titleJa).toBe('[アンソロジー] エログロス Vol.2 [DL版]')
    expect(m.tags).toContainEqual({ type: 'language', name: 'japanese' })
    expect(m.tags.length).toBe(jpg.tags.length)
  })
  it('雙副檔名 cover.jpg.webp 原樣保留路徑、格式取最後一段', () => {
    const m = parseGallery(webp, 'api-v2')
    expect(m.coverPath).toBe('galleries/4301004/cover.jpg.webp')
    expect(m.coverExt).toBe('webp')
  })
  it('cover.path 不合法或與 media_id 不符 → BAD_FORMAT', () => {
    const bad = [
      { ...jpg, cover: undefined },
      { ...jpg, cover: { ...jpg.cover, path: 'galleries/999/cover.jpg' } },
      { ...jpg, cover: { ...jpg.cover, path: 'galleries/1205270/1.jpg' } },
      { ...jpg, cover: { ...jpg.cover, path: '../galleries/1205270/cover.jpg' } },
      { ...jpg, cover: { ...jpg.cover, path: 'galleries/1205270/cover.exe' } },
      { ...jpg, cover: { ...jpg.cover, path: 'https://evil.example/galleries/1205270/cover.jpg' } },
      { ...jpg, media_id: 'abc' },
    ]
    for (const j of bad) expect(() => parseGallery(j, 'api-v2')).toThrow('BAD_FORMAT')
  })
  it('v1 解析器不吃 v2 回應、未知格式丟 BAD_FORMAT', () => {
    expect(() => parseGallery(jpg, 'api-v1')).toThrow('BAD_FORMAT')
    expect(() => parseGallery(jpg, 'api-v3')).toThrow('BAD_FORMAT')
  })
})

describe('parseCoverPath', () => {
  it('接受已知格式', () => {
    expect(parseCoverPath('galleries/1/cover.png')).toEqual({ path: 'galleries/1/cover.png', mediaId: '1', ext: 'png' })
    expect(parseCoverPath('galleries/1/cover.webp').ext).toBe('webp')
  })
  it('拒絕其他路徑', () => {
    for (const p of [null, '', 'galleries/1/cover', 'galleries/1/cover.jpg?x=1', 'galleries/1/cover.jpg/..', 'galleries//cover.jpg', 'galleries/1/thumb.jpg']) {
      expect(parseCoverPath(p)).toBeNull()
    }
  })
})

describe('CDN 設定', () => {
  it('解析真實 /api/v2/cdn 回應', () => {
    const json = {
      image_servers: ['https://i1.nhentai.net', 'https://i2.nhentai.net'],
      thumb_servers: ['https://t1.nhentai.net', 'https://t2.nhentai.net', 'https://t3.nhentai.net', 'https://t4.nhentai.net'],
    }
    expect(parseCdnConfig(json).thumbServers).toEqual([
      'https://t1.nhentai.net',
      'https://t2.nhentai.net',
      'https://t3.nhentai.net',
      'https://t4.nhentai.net',
    ])
  })
  it('過濾 http、外網域、帶路徑或帳密的伺服器', () => {
    const json = {
      thumb_servers: [
        'http://t1.nhentai.net',
        'https://evil.example',
        'https://nhentai.net.evil.example',
        'https://t2.nhentai.net/x',
        'https://u:p@t3.nhentai.net',
        'https://t4.nhentai.net:8443',
        'https://T5.nhentai.net/',
      ],
    }
    expect(parseCdnConfig(json).thumbServers).toEqual(['https://t5.nhentai.net'])
  })
  it('沒有可用伺服器 → BAD_FORMAT', () => {
    expect(() => parseCdnConfig({ thumb_servers: ['https://evil.example'] })).toThrow('BAD_FORMAT')
    expect(() => parseCdnConfig({})).toThrow('BAD_FORMAT')
    expect(() => parseCdnConfig(null)).toThrow('BAD_FORMAT')
  })
  it('normalizeCdnServer', () => {
    expect(normalizeCdnServer('https://t1.nhentai.net/')).toBe('https://t1.nhentai.net')
    expect(normalizeCdnServer('not a url')).toBeNull()
  })
  it('buildCdnUrl：伺服器 + path 原樣串接', () => {
    expect(buildCdnUrl('https://t1.nhentai.net', 'galleries/4301004/cover.jpg.webp')).toBe(
      'https://t1.nhentai.net/galleries/4301004/cover.jpg.webp',
    )
    expect(() => buildCdnUrl('https://evil.example', 'galleries/1/cover.jpg')).toThrow('ENDPOINT_INVALID')
    expect(() => buildCdnUrl('https://t1.nhentai.net', '../x')).toThrow('ENDPOINT_INVALID')
  })
})

describe('isApiRetired', () => {
  const retired = 'Use new API https://nhentai.net/api/v2/docs'
  it('舊 API 停用回應（實測 403 text/plain）', () => {
    expect(isApiRetired({ status: 403, body: retired })).toBe(true)
    expect(isApiRetired({ status: 410, body: retired })).toBe(true)
  })
  it('不是停用回應', () => {
    expect(isApiRetired({ status: 200, body: retired })).toBe(false)
    expect(isApiRetired({ status: 403, body: '<html><title>Just a moment...</title></html>' })).toBe(false)
    expect(isApiRetired({ status: 404, body: '{"error":"Gallery not found"}' })).toBe(false)
    expect(isApiRetired()).toBe(false)
  })
  it('isChallengePage 不受影響：停用回應不是 challenge', () => {
    expect(isChallengePage({ status: 403, contentType: 'text/plain', body: retired })).toBe(false)
  })
  it('v2 404 JSON 不是 challenge', () => {
    expect(isChallengePage({ status: 404, contentType: 'application/json', body: '{"error":"Gallery not found"}' })).toBe(false)
  })
})
