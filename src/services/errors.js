// 服務層統一的錯誤碼；介面只依錯誤碼顯示訊息（見 i18n 的 err.* 字串）。
export const E = Object.freeze({
  INVALID_ID: 'INVALID_ID',
  DUPLICATE: 'DUPLICATE',
  OFFLINE: 'OFFLINE',
  TIMEOUT: 'TIMEOUT',
  NOT_FOUND: 'NOT_FOUND',
  BLOCKED: 'BLOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
  BAD_FORMAT: 'BAD_FORMAT',
  COVER_FAILED: 'COVER_FAILED',
  STORAGE_FULL: 'STORAGE_FULL',
  DB_FAILED: 'DB_FAILED',
  FOLDER_NAME_INVALID: 'FOLDER_NAME_INVALID',
  FOLDER_NAME_DUP: 'FOLDER_NAME_DUP',
  ENDPOINT_INVALID: 'ENDPOINT_INVALID',
  CSV_INVALID: 'CSV_INVALID',
  UNKNOWN: 'UNKNOWN',
})

export class AppError extends Error {
  /**
   * @param {string} code  E.* 其中之一
   * @param {object} [extra] 例如 { retryAfter: 30, httpStatus: 503 }
   */
  constructor(code, extra = {}) {
    super(code)
    this.name = 'AppError'
    this.code = code
    Object.assign(this, extra)
  }
}

export function toAppError(err) {
  if (err instanceof AppError) return err
  const msg = String(err?.message || err || '')
  if (/ENOSPC|No space|disk full|SQLITE_FULL/i.test(msg)) return new AppError(E.STORAGE_FULL, { cause: msg })
  return new AppError(E.UNKNOWN, { cause: msg })
}
