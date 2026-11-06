// 純函式：「先存、後查」加入流程的判斷（不碰網路、資料庫），方便單元測試。

/**
 * 按「加入」時，依本機資料決定要做什麼。不發任何網路請求；書是否存在於網站由背景佇列判斷。
 * @param {{folderIds:number[]}|null} existing 已收藏時為這本書目前所在的資料夾 ID，未收藏為 null
 * @param {number[]} selectedFolderIds 加入頁選的資料夾（空陣列＝未分類）
 * @returns {{kind:'new', folderIds:number[]}
 *   | {kind:'already'}
 *   | {kind:'addFolders', toAdd:number[], originalFolderIds:number[]}}
 *   - new：沒收藏過 → 新建一筆「待補資料」並放進所選資料夾
 *   - already：已在所選的每個資料夾（或沒選資料夾且已收藏）→ 不做任何事
 *   - addFolders：已收藏但不在部分所選資料夾 → 只補資料夾關聯，不重抓資料與封面
 */
export function planAdd(existing, selectedFolderIds = []) {
  const selected = [...new Set((selectedFolderIds || []).map(Number).filter(Number.isFinite))]
  if (!existing) return { kind: 'new', folderIds: selected }
  const have = new Set((existing.folderIds || []).map(Number))
  const toAdd = selected.filter((id) => !have.has(id))
  if (!toAdd.length) return { kind: 'already' }
  return { kind: 'addFolders', toAdd, originalFolderIds: [...have] }
}
