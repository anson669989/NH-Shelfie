import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseGalleryId, parseGallery, fillTemplate, validateEndpointTemplate, sniffImageExt, normalizeFolderName } from '../src/services/parse.js'

describe('parseGalleryId', () => {
  it('接受 1–7 位正整數', () => {
    expect(parseGalleryId('177013')).toBe(177013)
    expect(parseGalleryId(' 1 ')).toBe(1)
    expect(parseGalleryId('1234567')).toBe(1234567)
  })
  it('從網址取出數字', () => {
    expect(parseGalleryId('https://nhentai.net/g/228922/')).toBe(228922)
    expect(parseGalleryId('nhentai.net/g/123456')).toBe(123456)
    expect(parseGalleryId('https://nhentai.net/g/123456/1/')).toBe(123456)
  })
  it('拒絕不合法輸入', () => {
    for (const bad of ['', '0', '-5', '12345678', 'abc', '12a', 'https://example.com/123', null, undefined]) {
      expect(parseGalleryId(bad)).toBeNull()
    }
  })
})

describe('fillTemplate', () => {
  it('只接受英數值', () => {
    expect(fillTemplate('https://nhentai.net/g/{id}/', { id: 5 })).toBe('https://nhentai.net/g/5/')
    expect(() => fillTemplate('https://x/{id}', { id: '../etc' })).toThrow()
    expect(() => fillTemplate('https://x/{id}', {})).toThrow()
  })
})

describe('validateEndpointTemplate', () => {
  it('只接受 https 且含必要欄位', () => {
    expect(validateEndpointTemplate('https://nhentai.net/api/gallery/{id}', ['id'])).toBe(true)
    expect(validateEndpointTemplate('http://nhentai.net/api/gallery/{id}', ['id'])).toBe(false)
    expect(validateEndpointTemplate('https://nhentai.net/api/gallery/', ['id'])).toBe(false)
    expect(validateEndpointTemplate('javascript:alert(1)//{id}', ['id'])).toBe(false)
  })
})

describe('parseGallery', () => {
  const sample = JSON.parse(readFileSync(new URL('./fixtures/gallery-api-v1.json', import.meta.url), 'utf8'))
  it('解析樣本回應', () => {
    const m = parseGallery(sample)
    expect(m.mediaId).toBe('987560')
    expect(m.coverExt).toBe('jpg')
    expect(m.title).toBe('Sample Title')
    expect(m.titleJa).toBe('サンプル')
    expect(m.tags).toContainEqual({ type: 'language', name: 'english' })
  })
  it('缺少必要欄位時丟 BAD_FORMAT', () => {
    expect(() => parseGallery({ ...sample, media_id: undefined })).toThrow('BAD_FORMAT')
    expect(() => parseGallery({ ...sample, images: {} })).toThrow('BAD_FORMAT')
    expect(() => parseGallery('<html>')).toThrow('BAD_FORMAT')
  })
  it('標題缺少時不崩潰', () => {
    expect(parseGallery({ ...sample, title: null }).title).toBe('')
  })
})

describe('sniffImageExt', () => {
  it('依檔頭判斷', () => {
    expect(sniffImageExt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('jpg')
    expect(sniffImageExt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe('png')
    expect(sniffImageExt(new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)))))).toBe('webp')
    expect(sniffImageExt(Buffer.from('<!DOCTYPE html><html>').toString('base64'))).toBeNull()
    expect(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 5, 6, 7, 8, 9]).toString('base64'))).toBe('jpg')
  })
})

describe('normalizeFolderName', () => {
  it('去空白並限制長度', () => {
    expect(normalizeFolderName('  待看  ')).toBe('待看')
    expect(normalizeFolderName('   ')).toBeNull()
    expect(normalizeFolderName('a'.repeat(31))).toBeNull()
    expect(normalizeFolderName('字'.repeat(30))).toBe('字'.repeat(30))
  })
})
