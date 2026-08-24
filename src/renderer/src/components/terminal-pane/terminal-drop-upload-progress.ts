const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** Both figures share the total's unit; scaling each alone renders "900 / 32.5". */
export function formatTransferredOfTotal(sentBytes: number, totalBytes: number): string {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return `0 ${BYTE_UNITS[0]}`
  }
  let unitIndex = 0
  let divisor = 1
  while (totalBytes / divisor >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    divisor *= 1024
    unitIndex += 1
  }
  const scaledTotal = totalBytes / divisor
  const scaledSent = Math.min(Math.max(sentBytes, 0), totalBytes) / divisor
  const precision = scaledTotal >= 100 || unitIndex === 0 ? 0 : scaledTotal >= 10 ? 1 : 2
  return `${scaledSent.toFixed(precision)} / ${scaledTotal.toFixed(precision)} ${BYTE_UNITS[unitIndex]}`
}

export function toPercent(sentBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) {
    return 0
  }
  // Why: floor, so a bar only reads 100% once the last byte has actually landed.
  return Math.min(100, Math.max(0, Math.floor((sentBytes / totalBytes) * 100)))
}
