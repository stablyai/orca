export const SESSION_SEARCH_LIMIT_DEFAULT = 20
export const SESSION_SEARCH_LIMIT_MAX = 100

export function resolveSessionSearchLimit(limit: number | undefined): number {
  // Non-positive limits otherwise make slice silently drop hits.
  const requested = Number.isInteger(limit) ? (limit as number) : SESSION_SEARCH_LIMIT_DEFAULT
  return Math.min(Math.max(1, requested), SESSION_SEARCH_LIMIT_MAX)
}
