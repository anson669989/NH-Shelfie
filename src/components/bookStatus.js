// 書的抓取狀態 → 佔位圖文字的 i18n key（收藏頁與加入頁共用；不碰任何 I/O）
export function statusKey(book) {
  switch (book?.fetch_status) {
    case 'meta_pending':
    case 'cover_pending':
      return 'book.loading'
    case 'not_found':
      return 'book.notFound'
    case 'meta_failed':
      return 'book.metaFailed'
    default:
      return 'book.coverFailed'
  }
}

export const isLoadingStatus = (book) => book?.fetch_status === 'meta_pending' || book?.fetch_status === 'cover_pending'
