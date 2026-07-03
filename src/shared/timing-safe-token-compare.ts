import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison for secret tokens (auth tokens, bearer tokens,
 * daemon handshakes, hook-auth headers).
 *
 * Why: `===` / `!==` short-circuit on the first differing character, leaking
 * how many leading bytes match via response timing. `crypto.timingSafeEqual`
 * eliminates that leak but throws `RangeError` when the buffers differ in
 * length, so the length mismatch must be handled without an early return that
 * itself leaks length information.
 */
export function timingSafeTokenCompare(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(actual, 'utf8')
  // Why: keep the timingSafeEqual call count constant. Comparing the expected
  // buffer against itself runs for the same duration as a real compare so a
  // mismatched length cannot be inferred from early-return timing.
  if (expectedBuf.length !== actualBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }
  return timingSafeEqual(expectedBuf, actualBuf)
}
