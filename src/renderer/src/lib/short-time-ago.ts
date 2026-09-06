/** Compact "now / 5m / 3h / 2d" age label shared by agent rows and activity threads. */
export function formatShortTimeAgo(ts: number, now = Date.now()): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}
