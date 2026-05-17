/**
 * Returns a short human-readable label for a usage window duration.
 *
 * Why: the status bar uses duration labels, so the weekly bucket is shown as
 * "7d" instead of a calendar-period label like "wk".
 */
export function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes === 10080) {
    return '7d'
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
