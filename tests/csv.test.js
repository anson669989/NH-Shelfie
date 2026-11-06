import { describe, it, expect } from 'vitest'
import { buildCsv, parseCsvText, validateCsv } from '../src/services/csv.js'

const rows = [
  { gallery_id: 177013, folders: ['收藏', '待看'], note: '', added_at: 1762397700 },
  { gallery_id: 228922, folders: [], note: '好看, "推"\n第二行', added_at: 1762398120 },
  { gallery_id: 5, folders: ['-負號開頭'], note: '=SUM(A1:A2)', added_at: 1762398200 },
]

describe('CSV', () => {
  it('匯出含 BOM 與標頭', () => {
    const csv = buildCsv(rows)
    expect(csv.startsWith('﻿gallery_id,folders,note,added_at\r\n')).toBe(true)
  })

  it('公式開頭的儲存格加單引號', () => {
    const csv = buildCsv(rows)
    expect(csv).toContain("'=SUM(A1:A2)")
    expect(csv).toContain("'-負號開頭")
  })

  it('匯出再匯入後資料相同', () => {
    const csv = buildCsv(rows)
    const res = validateCsv(csv)
    expect(res.headerOk).toBe(true)
    expect(res.skipped).toEqual([])
    expect(res.ok).toEqual(rows)
  })

  it('跳過已存在、重複與壞行，並給出原因', () => {
    const text = [
      'gallery_id,folders,note,added_at',
      '177013,收藏,,2026-11-06T10:55:00+08:00',
      '228922,未分類,好看,2026-11-06T11:02:00+08:00',
      'abc,收藏,,',
      '228922,,,',
      '300000,,,not-a-date',
      `400000,${'x'.repeat(31)},,`,
    ].join('\n')
    const res = validateCsv(text, new Set([177013]))
    expect(res.ok.map((r) => r.gallery_id)).toEqual([228922])
    expect(res.ok[0].folders).toEqual([])
    expect(res.ok[0].note).toBe('好看')
    expect(res.skipped.map((s) => s.reason)).toEqual([
      'duplicate',
      'invalid_id',
      'duplicate_in_file',
      'invalid_date',
      'invalid_folder',
    ])
  })

  it('缺少 gallery_id 欄時標頭無效', () => {
    expect(validateCsv('id,folders\n1,a').headerOk).toBe(false)
  })

  it('解析引號內逗號與換行', () => {
    expect(parseCsvText('a,"b,c","d\n""e"""\r\n1,2,3')).toEqual([
      ['a', 'b,c', 'd\n"e"'],
      ['1', '2', '3'],
    ])
  })
})
