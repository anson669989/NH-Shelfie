// 任務 006：四種語言（繁中／简中／English／日本語）的文字鍵必須完全一致，且自動偵測規則正確
import { describe, it, expect } from 'vitest'
import { DICTS, LANGUAGES, detectLang } from '../src/locales.js'

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('四語文字鍵一致', () => {
  const base = Object.keys(DICTS['zh-TW']).sort()

  it('共有四種語言，且語言選單都列出', () => {
    expect(Object.keys(DICTS).sort()).toEqual(['en', 'ja', 'zh-CN', 'zh-TW'])
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(Object.keys(DICTS).sort())
    expect(LANGUAGES.find((l) => l.code === 'zh-CN').label).toBe('简体中文')
  })

  for (const lang of ['zh-CN', 'en', 'ja']) {
    it(`${lang} 與 zh-TW 的鍵完全相同（沒有漏翻、沒有多餘）`, () => {
      const keys = Object.keys(DICTS[lang]).sort()
      expect(keys.filter((k) => !base.includes(k))).toEqual([])
      expect(base.filter((k) => !keys.includes(k))).toEqual([])
    })
    it(`${lang} 的 {變數} 與 zh-TW 相同，且沒有空字串`, () => {
      for (const k of base) {
        expect(String(DICTS[lang][k]).trim(), `${lang} ${k}`).not.toBe('')
        expect(placeholders(DICTS[lang][k]), `${lang} ${k}`).toEqual(placeholders(DICTS['zh-TW'][k]))
      }
    })
  }

  it('简体中文採大陸用詞（設置、文件夾、數據）', () => {
    expect(DICTS['zh-CN']['nav.settings']).toBe('设置')
    expect(DICTS['zh-CN']['nav.folders']).toBe('文件夹')
    expect(DICTS['zh-CN']['settings.data']).toBe('数据')
  })
})

describe('detectLang：手機語言自動偵測', () => {
  it('简体', () => {
    for (const tag of ['zh-CN', 'zh-Hans', 'zh-SG', 'zh-Hans-CN', 'zh_CN', 'zh-hans-sg']) expect(detectLang(tag), tag).toBe('zh-CN')
  })
  it('繁體', () => {
    for (const tag of ['zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-TW', 'zh-Hant-HK', 'zh-MO', 'zh']) expect(detectLang(tag), tag).toBe('zh-TW')
  })
  it('日文與其他', () => {
    expect(detectLang('ja-JP')).toBe('ja')
    expect(detectLang('en-US')).toBe('en')
    expect(detectLang('ko-KR')).toBe('en')
    expect(detectLang('')).toBe('en')
  })
})
