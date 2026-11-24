/** Share localized major-unit display across usage/status surfaces; malformed provider currency codes fall back to CODE amount instead of throwing into the status bar. */
export function formatCurrencyAmount(amount: number, currencyCode: string): string {
  const safeAmount = Number.isFinite(amount) ? amount : 0
  const code = currencyCode.trim() || 'USD'
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code
    }).format(safeAmount)
  } catch {
    return `${code} ${safeAmount.toFixed(2)}`
  }
}
