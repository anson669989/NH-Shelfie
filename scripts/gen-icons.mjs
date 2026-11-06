// 產生 App 圖示（原創設計：主題紅底 + 白色書本），只用 Node 內建模組，不加套件。
// 由 scripts/patch-android.mjs 呼叫，寫進 android/app/src/main/res；CI 每次建置都會自動套用。
// 也可單獨執行：node scripts/gen-icons.mjs <res 目錄> 產生到指定位置（預覽用）。
//
// 產出：
// - mipmap-*/ic_launcher.png、ic_launcher_round.png：Android 7.1 以下用的傳統圖示（方形圓角／圓形）
// - mipmap-*/ic_launcher_foreground.png：Android 8 以上自適應圖示的前景（透明底，內容在安全區內）
// - mipmap-anydpi-v26/ic_launcher.xml、ic_launcher_round.xml：自適應圖示定義
// - values/nh_icon_background.xml：自適應圖示背景色
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ICON_BG = '#ed2553' // 與預設主題色相同
const WHITE = [255, 255, 255]
const SPINE = [252, 205, 215] // 書背：淡粉
const PAGES = [255, 236, 240] // 書頁：更淡的粉
const RIBBON = [196, 18, 58] // 書籤：深紅

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }

// ---------- PNG 編碼 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** @param {Uint8Array} rgba 長度 size*size*4 */
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 圖形（座標皆為 0–1 的比例） ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

/**
 * 書本：以 (cx, cy) 為中心、高度 h 的直立書本（書背在左、底部露出書頁、右上角書籤）。
 * 回傳該點顏色或 null。
 */
function bookColor(x, y, cx, cy, h) {
  const w = h * 0.76
  const x0 = cx - w / 2
  const x1 = cx + w / 2
  const y0 = cy - h / 2
  const y1 = cy + h / 2
  const r = h * 0.07
  if (!inRoundRect(x, y, x0, y0, x1, y1, r)) return null
  // 書籤（右上，向下垂、尾端 V 形缺口）
  const bx0 = x1 - w * 0.3
  const bx1 = x1 - w * 0.14
  const by1 = y0 + h * 0.36
  if (x >= bx0 && x <= bx1 && y >= y0 && y <= by1) {
    const mid = (bx0 + bx1) / 2
    const notch = h * 0.07 * (1 - Math.abs(x - mid) / ((bx1 - bx0) / 2))
    if (y <= by1 - notch) return RIBBON
  }
  // 書背
  if (x <= x0 + w * 0.17) return SPINE
  // 底部書頁（三條細線）
  if (y >= y1 - h * 0.15 && x <= x1 - w * 0.06) {
    const band = (y - (y1 - h * 0.15)) / (h * 0.15)
    return Math.floor(band * 6) % 2 === 0 ? PAGES : WHITE
  }
  return WHITE
}

/**
 * 以超取樣（4×4）抗鋸齒繪製。
 * @param {number} size 像素
 * @param {'square'|'round'|'foreground'} kind
 */
export function renderIcon(size, kind) {
  const bg = hex(ICON_BG)
  const out = new Uint8Array(size * size * 4)
  const S = 4
  // 傳統圖示：書高 0.56；自適應前景：畫布 108dp、安全區直徑 66dp → 書高 0.40
  const bookH = kind === 'foreground' ? 0.4 : 0.56
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size
          const y = (py + (sy + 0.5) / S) / size
          let col = null
          let alpha = 0
          const inBg =
            kind === 'square'
              ? inRoundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.18)
              : kind === 'round'
                ? (x - 0.5) ** 2 + (y - 0.5) ** 2 <= 0.46 ** 2
                : false
          if (inBg) {
            col = bg
            alpha = 1
          }
          const bc = bookColor(x, y, 0.5, 0.5, bookH)
          if (bc && (inBg || kind === 'foreground')) {
            col = bc
            alpha = 1
          }
          if (col) {
            r += col[0]
            g += col[1]
            b += col[2]
            a += alpha
          }
        }
      }
      const i = (py * size + px) * 4
      if (a > 0) {
        out[i] = Math.round(r / a)
        out[i + 1] = Math.round(g / a)
        out[i + 2] = Math.round(b / a)
        out[i + 3] = Math.round((a / (S * S)) * 255)
      }
    }
  }
  return out
}

const ADAPTIVE_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/gen-icons.mjs 產生，請勿手動修改 -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/nh_icon_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`

/** 寫入所有圖示到 Android 的 res 目錄。 */
export function generateIcons(resDir) {
  const written = []
  for (const [d, scale] of Object.entries(DENSITIES)) {
    const dir = join(resDir, `mipmap-${d}`)
    mkdirSync(dir, { recursive: true })
    const legacy = Math.round(48 * scale)
    const fg = Math.round(108 * scale)
    writeFileSync(join(dir, 'ic_launcher.png'), encodePng(legacy, renderIcon(legacy, 'square')))
    writeFileSync(join(dir, 'ic_launcher_round.png'), encodePng(legacy, renderIcon(legacy, 'round')))
    writeFileSync(join(dir, 'ic_launcher_foreground.png'), encodePng(fg, renderIcon(fg, 'foreground')))
    written.push(`mipmap-${d}`)
  }
  const anydpi = join(resDir, 'mipmap-anydpi-v26')
  mkdirSync(anydpi, { recursive: true })
  writeFileSync(join(anydpi, 'ic_launcher.xml'), ADAPTIVE_XML)
  writeFileSync(join(anydpi, 'ic_launcher_round.xml'), ADAPTIVE_XML)
  const values = join(resDir, 'values')
  mkdirSync(values, { recursive: true })
  writeFileSync(
    join(values, 'nh_icon_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/gen-icons.mjs 產生，請勿手動修改 -->
<resources>
    <color name="nh_icon_background">${ICON_BG}</color>
</resources>
`,
  )
  return written
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2]
  if (!out) {
    console.error('用法：node scripts/gen-icons.mjs <res 目錄>')
    process.exit(1)
  }
  console.log('✔ 已產生圖示：', generateIcons(out).join(', '))
}
