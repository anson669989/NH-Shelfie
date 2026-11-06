// 任務 006：ID 輸入（# 開頭、全形）、分享文字取 ID、「先存、後查」加入判斷
import { describe, it, expect } from 'vitest'
import { parseGalleryId, extractGalleryId, parseGallery } from '../src/services/parse.js'
import { planAdd } from '../src/services/addPlan.js'
import { readFileSync } from 'node:fs'

describe('parseGalleryId：# 開頭', () => {
  it('接受 #、# 加空白、全形＃、前後空白', () => {
    expect(parseGalleryId('#228922')).toBe(228922)
    expect(parseGalleryId('# 228922')).toBe(228922)
    expect(parseGalleryId('  #228922  ')).toBe(228922)
    expect(parseGalleryId('＃228922')).toBe(228922)
    expect(parseGalleryId('＃　228922')).toBe(228922)
    expect(parseGalleryId('＃２２８９２２')).toBe(228922)
  })
  it('原本支援的純數字與網址仍可用', () => {
    expect(parseGalleryId('228922')).toBe(228922)
    expect(parseGalleryId('https://nhentai.net/g/228922/')).toBe(228922)
  })
  it('拒絕不合法的 # 輸入', () => {
    for (const bad of ['#', '##228922', '#0', '#12345678', '#12a', '228922#']) expect(parseGalleryId(bad)).toBeNull()
  })
})

describe('extractGalleryId：分享內容', () => {
  it('網址', () => {
    expect(extractGalleryId('https://nhentai.net/g/228922/')).toBe(228922)
  })
  it('含網址的一段文字', () => {
    expect(extractGalleryId('看看這本 Some Title | nhentai https://nhentai.net/g/228922/ 不錯')).toBe(228922)
    expect(extractGalleryId('Title\nhttps://nhentai.net/g/228922')).toBe(228922)
  })
  it('多個 ID 只取第一個（依出現位置）', () => {
    expect(extractGalleryId('https://nhentai.net/g/111111/ and https://nhentai.net/g/222222/')).toBe(111111)
    expect(extractGalleryId('#333333 then https://nhentai.net/g/444444/')).toBe(333333)
  })
  it('純數字或 # 開頭', () => {
    expect(extractGalleryId(' 228922 ')).toBe(228922)
    expect(extractGalleryId('#228922')).toBe(228922)
  })
  it('找不到 ID', () => {
    for (const bad of ['', null, 'hello', 'https://example.com/a/123', 'year 2024 page 5']) expect(extractGalleryId(bad)).toBeNull()
  })
})

describe('parseGallery：英文完整標題', () => {
  it('輸出 titleEn', () => {
    const json = JSON.parse(readFileSync(new URL('./fixtures/gallery-api-v2.json', import.meta.url), 'utf8'))
    const m = parseGallery(json, 'api-v2')
    expect(m.titleEn).toBe(json.title.english)
  })
})

describe('planAdd：按「加入」只做本機判斷', () => {
  it('c. 沒收藏過 → 新建（帶所選資料夾）', () => {
    expect(planAdd(null, [3, 5])).toEqual({ kind: 'new', folderIds: [3, 5] })
    expect(planAdd(null, [])).toEqual({ kind: 'new', folderIds: [] })
  })
  it('a. 已在目前選的資料夾 → 不重複加入', () => {
    expect(planAdd({ folderIds: [3] }, [3])).toEqual({ kind: 'already' })
    expect(planAdd({ folderIds: [3, 5] }, [5, 3])).toEqual({ kind: 'already' })
    expect(planAdd({ folderIds: [] }, [])).toEqual({ kind: 'already' })
    expect(planAdd({ folderIds: [3] }, [])).toEqual({ kind: 'already' })
  })
  it('b. 已收藏但不在這個資料夾 → 只補資料夾，回傳原本所在資料夾', () => {
    expect(planAdd({ folderIds: [1, 2] }, [3])).toEqual({ kind: 'addFolders', toAdd: [3], originalFolderIds: [1, 2] })
    expect(planAdd({ folderIds: [1] }, [1, 4])).toEqual({ kind: 'addFolders', toAdd: [4], originalFolderIds: [1] })
    expect(planAdd({ folderIds: [] }, [2])).toEqual({ kind: 'addFolders', toAdd: [2], originalFolderIds: [] })
  })
  it('重複的資料夾 ID 只算一次', () => {
    expect(planAdd(null, [3, 3])).toEqual({ kind: 'new', folderIds: [3] })
  })
})
