/** After a clear suppressed by IME, preserve only the composed segment; compare both ends because the caret need not be at the end. */
export function imeComposedSegment(base: string, settled: string): string {
  const limit = Math.min(base.length, settled.length)
  let prefix = 0
  while (prefix < limit && base[prefix] === settled[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < limit - prefix &&
    base[base.length - 1 - suffix] === settled[settled.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return settled.slice(prefix, settled.length - suffix)
}
