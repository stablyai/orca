/** Cursor individual plans reset two pools each reported period, then optionally bill on-demand usage: https://cursor.com/docs/account/pricing */
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
