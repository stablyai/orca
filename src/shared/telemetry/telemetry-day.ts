export function utcDayIndex(now = Date.now()): number {
  return Math.floor(now / 86_400_000)
}
