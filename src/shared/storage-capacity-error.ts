export function storageCapacityErrorCode(
  error: unknown,
  seen = new Set<object>()
): 'ENOSPC' | 'EDQUOT' | 'SQLITE_FULL' | null {
  if (typeof error !== 'object' || error === null || seen.has(error)) {
    return null
  }
  seen.add(error)
  // node:sqlite reports SQLITE_FULL through its numeric SQLite result code.
  if (
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    'errcode' in error &&
    error.errcode === 13
  ) {
    return 'SQLITE_FULL'
  }
  if (
    'code' in error &&
    (error.code === 'ENOSPC' || error.code === 'EDQUOT' || error.code === 'SQLITE_FULL')
  ) {
    return error.code
  }
  return 'cause' in error ? storageCapacityErrorCode(error.cause, seen) : null
}
