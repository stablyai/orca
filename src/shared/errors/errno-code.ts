// Node/libuv errno codes (`EACCES`, `E2BIG`); anchored and capped so a code can't carry a path.
export const ERRNO_CODE_PATTERN = /^E[A-Z0-9]{1,15}$/

export function errnoCodeOrUnknown(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  return typeof code === 'string' && ERRNO_CODE_PATTERN.test(code) ? code : 'unknown'
}
