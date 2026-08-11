const UNITS = [
  ['d', 86_400],
  ['h', 3_600],
  ['m', 60],
  ['s', 1]
] as const

/**
 * Renders an SSH relay grace period as at most two units, largest first.
 *
 * Why two units: the single-unit form only held when the value divided evenly, so an
 * off-by-1000 entry like 600000s rendered as "10000m" and read as a plausible number
 * rather than the week it actually is.
 */
export function formatSshRelayGraceDuration(seconds: number): string | null {
  if (!Number.isInteger(seconds) || seconds < 0) {
    return null
  }
  const headIndex = UNITS.findIndex(([, size]) => seconds >= size)
  if (headIndex === -1) {
    return '0s'
  }
  const [headSuffix, headSize] = UNITS[headIndex]
  const head = Math.floor(seconds / headSize)
  const tailUnit = UNITS[headIndex + 1]
  if (!tailUnit) {
    return `${head}${headSuffix}`
  }
  const [tailSuffix, tailSize] = tailUnit
  const tail = Math.floor((seconds - head * headSize) / tailSize)
  return tail === 0 ? `${head}${headSuffix}` : `${head}${headSuffix} ${tail}${tailSuffix}`
}
