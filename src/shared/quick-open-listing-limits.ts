// Why: the renderer imports this module, so it must stay free of Node-only code.
export const QUICK_OPEN_LISTING_MAX_RESULTS = 20_001

export function resolveQuickOpenResultLimit(requested?: number): number {
  if (requested === undefined || requested === Number.POSITIVE_INFINITY) {
    return QUICK_OPEN_LISTING_MAX_RESULTS
  }
  if (!Number.isFinite(requested)) {
    return 0
  }
  return Math.min(Math.max(Math.trunc(requested), 0), QUICK_OPEN_LISTING_MAX_RESULTS)
}
