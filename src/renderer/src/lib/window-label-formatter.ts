/**
 * Returns a short human-readable label for a usage window duration.
 *
 * Why: 10080 minutes (7 days) is hard-coded as "wk" for backward
 * compatibility with the original StatusBar implementation.
 */
export function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes === 10080) {
    return 'wk'
  }
  if (windowMinutes === 300) {
    return '5h'
  }
  if (windowMinutes === 60) {
    return '1h'
  }
  if (windowMinutes < 60) {
    return `${windowMinutes}m`
  }
  if (windowMinutes % (60 * 24 * 7) === 0) {
    return `${windowMinutes / (60 * 24 * 7)}wk`
  }
  if (windowMinutes % (60 * 24) === 0) {
    return `${windowMinutes / (60 * 24)}d`
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`
  }
  return `${windowMinutes}m`
}
