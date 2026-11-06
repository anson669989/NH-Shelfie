// CSV 匯出 / 匯入的純函式部分（無 I/O），方便測試「匯出再匯入後資料相同」。
import { parseGalleryId, normalizeFolderName } from './parse.js'

export const CSV_HEADER = ['gallery_id', 'folders', 'note', 'added_at']
export const CSV_MAX_BYTES = 5 * 1024 * 1024
export const CSV_MAX_ROWS = 20000
const BOM = '﻿'
const UNCATEGORIZED_ALIASES = new Set(['未分類', '未分类', 'Uncategorized', '未分類 '])

/** 防止 Excel 把 = + - @ 開頭的儲存格當公式 */
function guardFormula(s) {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}
function unguardFormula(s) {
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s
}
function quote(s) {
  s = String(s ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 以裝置時區輸出 ISO 8601，例如 2026-11-06T10:55:00+08:00 */
export function toLocalIso(unixSec) {
  const d = new Date(unixSec * 1000)
  const pad = (n) => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  )
}

/**
 * @param {{gallery_id:number, folders:string[], note:string|null, added_at:number}[]} rows
 * @returns {string} 含 BOM 的 CSV 文字
 */
export function buildCsv(rows) {
  const lines = [CSV_HEADER.join(',')]
  for (const r of rows) {
    lines.push(
      [
        String(r.gallery_id),
        quote(guardFormula((r.folders || []).join('|'))),
        quote(guardFormula(r.note || '')),
        toLocalIso(r.added_at),
      ].join(','),
    )
  }
  return BOM + lines.join('\r\n') + '\r\n'
}

/** RFC 4180 風格的 CSV 解析（支援引號、跳脫雙引號、引號內換行）。 */
export function parseCsvText(text) {
  if (text.startsWith(BOM)) text = text.slice(1)
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''))
}

/**
 * 逐列驗證 CSV。
 * @param {string} text
 * @param {Set<number>} existingIds 已收藏的 ID（將被跳過）
 * @returns {{ ok: {gallery_id:number, folders:string[], note:string, added_at:number}[], skipped: {line:number, reason:string, raw?:string}[], headerOk: boolean }}
 */
export function validateCsv(text, existingIds = new Set()) {
  const rows = parseCsvText(text)
  const result = { ok: [], skipped: [], headerOk: false }
  if (!rows.length) return result
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const idx = Object.fromEntries(CSV_HEADER.map((h) => [h, header.indexOf(h)]))
  if (idx.gallery_id < 0) return result
  result.headerOk = true

  const seen = new Set()
  const body = rows.slice(1, CSV_MAX_ROWS + 1)
  body.forEach((r, i) => {
    const line = i + 2
    const id = parseGalleryId(r[idx.gallery_id])
    if (!id || !/^\s*\d+\s*$/.test(r[idx.gallery_id] ?? '')) {
      result.skipped.push({ line, reason: 'invalid_id', raw: r[idx.gallery_id] })
      return
    }
    if (existingIds.has(id)) {
      result.skipped.push({ line, reason: 'duplicate', raw: String(id) })
      return
    }
    if (seen.has(id)) {
      result.skipped.push({ line, reason: 'duplicate_in_file', raw: String(id) })
      return
    }
    const folderCell = idx.folders >= 0 ? unguardFormula(r[idx.folders] ?? '') : ''
    const folders = []
    let badFolder = false
    for (const part of folderCell.split('|')) {
      const t = part.trim()
      if (!t || UNCATEGORIZED_ALIASES.has(t)) continue
      const n = normalizeFolderName(t)
      if (!n) badFolder = true
      else if (!folders.includes(n)) folders.push(n)
    }
    if (badFolder) {
      result.skipped.push({ line, reason: 'invalid_folder', raw: folderCell })
      return
    }
    const note = idx.note >= 0 ? unguardFormula(r[idx.note] ?? '').slice(0, 2000) : ''
    let addedAt = Math.floor(Date.now() / 1000)
    if (idx.added_at >= 0 && (r[idx.added_at] ?? '').trim()) {
      const t = Date.parse(r[idx.added_at].trim())
      if (Number.isNaN(t)) {
        result.skipped.push({ line, reason: 'invalid_date', raw: r[idx.added_at] })
        return
      }
      addedAt = Math.floor(t / 1000)
    }
    seen.add(id)
    result.ok.push({ gallery_id: id, folders, note, added_at: addedAt })
  })
  if (rows.length - 1 > CSV_MAX_ROWS) {
    result.skipped.push({ line: CSV_MAX_ROWS + 2, reason: 'too_many_rows' })
  }
  return result
}
