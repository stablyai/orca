const CREDIT_COUNT_FORMATTER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 })

export function formatCreditCount(count: number): string {
  const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0
  return CREDIT_COUNT_FORMATTER.format(safeCount)
}
