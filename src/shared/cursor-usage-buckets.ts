/**
 * Cursor bills individual plans from two pools that both reset with the monthly
 * billing cycle, plus optional on-demand spend once the pools run out.
 * https://cursor.com/docs/account/pricing
 */
export const CURSOR_MODELS_BUCKET_NAME = 'Cursor Models'
export const CURSOR_OTHER_MODELS_BUCKET_NAME = 'Other Models'
export const CURSOR_ON_DEMAND_BUCKET_NAME = 'On-demand'

export const CURSOR_USAGE_BUCKET_NAMES = [
  CURSOR_MODELS_BUCKET_NAME,
  CURSOR_OTHER_MODELS_BUCKET_NAME,
  CURSOR_ON_DEMAND_BUCKET_NAME
] as const

export function isCursorUsageBucket(name: string): boolean {
  return CURSOR_USAGE_BUCKET_NAMES.some((bucket) => bucket === name)
}
