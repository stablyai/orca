import type { TransferRow } from './transfer-session-state'

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** Both figures share the total's unit; scaling each alone renders "900 / 32.5". */
export function formatTransferredOfTotal(sentBytes: number, totalBytes: number): string {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    // Why: a download whose size lookup failed still moves bytes worth showing.
    if (Number.isFinite(sentBytes) && sentBytes > 0) {
      const { divisor, unit, precision } = scaleFor(sentBytes)
      return `${(sentBytes / divisor).toFixed(precision)} ${unit}`
    }
    return `0 ${BYTE_UNITS[0]}`
  }
  const { divisor, unit, precision } = scaleFor(totalBytes)
  const scaledTotal = totalBytes / divisor
  const scaledSent = Math.min(Math.max(sentBytes, 0), totalBytes) / divisor
  return `${scaledSent.toFixed(precision)} / ${scaledTotal.toFixed(precision)} ${unit}`
}

function scaleFor(bytes: number): { divisor: number; unit: string; precision: number } {
  let unitIndex = 0
  let divisor = 1
  while (bytes / divisor >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    divisor *= 1024
    unitIndex += 1
  }
  const scaled = bytes / divisor
  const precision = scaled >= 100 || unitIndex === 0 ? 0 : scaled >= 10 ? 1 : 2
  return { divisor, unit: BYTE_UNITS[unitIndex], precision }
}

/** A finished row reads 100% even with no bytes to move (an empty file or folder). */
export function toRowPercent(
  row: Pick<TransferRow, 'status' | 'sentBytes' | 'totalBytes'>
): number {
  return row.status === 'done' ? 100 : toPercent(row.sentBytes, row.totalBytes)
}

export function toPercent(sentBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) {
    return 0
  }
  // Why: floor, so a bar only reads 100% once the last byte has actually landed.
  return Math.min(100, Math.max(0, Math.floor((sentBytes / totalBytes) * 100)))
}
