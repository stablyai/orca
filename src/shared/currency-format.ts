/**
 * Format a major-unit amount (e.g. 12.4) as a localized currency string
 * (e.g. "$12.40"). Shared by the usage popover and the compact status-bar
 * balance token so both render identically.
 *
 * Why: `Intl.NumberFormat` throws on an unrecognized currency code (the code
 * comes from a provider API we don't control), so fall back to a plain
 * "<CODE> <amount>" rendering rather than crashing the status bar.
 */
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
