// B4：App 圖示產生器（scripts/gen-icons.mjs）輸出合法 PNG、尺寸正確、內容為紅底白書。
import { describe, it, expect } from 'vitest'
import { inflateSync } from 'node:zlib'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePng, renderIcon, generateIcons } from '../scripts/gen-icons.mjs'

/** 解析本產生器輸出的 PNG（RGBA、filter none） */
function decode(buf) {
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const size = buf.readUInt32BE(16)
  let off = 8
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len))
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const px = (x, y) => {
    const i = y * (size * 4 + 1) + 1 + x * 4
    return [...raw.subarray(i, i + 4)]
  }
  return { size, px }
}

describe('gen-icons', () => {
  it('方形圖示：邊角透明、背景紅色、中央白色書本', () => {
    const { size, px } = decode(encodePng(96, renderIcon(96, 'square')))
    expect(size).toBe(96)
    expect(px(0, 0)[3]).toBe(0)
    expect(px(10, 48)).toEqual([0xed, 0x25, 0x53, 255])
    expect(px(52, 48)).toEqual([255, 255, 255, 255])
  })
  it('自適應前景：背景透明、書本在安全區（中央 66/108）內', () => {
    const { size, px } = decode(encodePng(108, renderIcon(108, 'foreground')))
    expect(px(5, 54)[3]).toBe(0)
    expect(px(56, 54)[3]).toBe(255)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (px(x, y)[3] > 0) expect((x + 0.5 - 54) ** 2 + (y + 0.5 - 54) ** 2).toBeLessThanOrEqual(33 ** 2)
      }
    }
  })
  it('寫出所有密度與自適應圖示設定', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nh-icons-'))
    try {
      generateIcons(dir)
      for (const [d, s] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
        expect(decode(readFileSync(join(dir, `mipmap-${d}`, 'ic_launcher.png'))).size).toBe(s)
        expect(existsSync(join(dir, `mipmap-${d}`, 'ic_launcher_round.png'))).toBe(true)
        expect(existsSync(join(dir, `mipmap-${d}`, 'ic_launcher_foreground.png'))).toBe(true)
      }
      expect(readFileSync(join(dir, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'utf8')).toContain('@mipmap/ic_launcher_foreground')
      expect(readFileSync(join(dir, 'values', 'nh_icon_background.xml'), 'utf8')).toContain('#ed2553')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
