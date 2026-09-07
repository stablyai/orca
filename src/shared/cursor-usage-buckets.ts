/** Canonical Cursor DashboardService bucket labels — keep producer and UI in sync. */
export const CURSOR_MODELS_BUCKET_NAME = 'Cursor Models'
export const CURSOR_OTHER_MODELS_BUCKET_NAME = 'Other models'
/** True for Cursor DashboardService bucket labels shown in the status bar. */
export function isCursorUsageBucket(name: string): boolean {
  return name === CURSOR_MODELS_BUCKET_NAME || name === CURSOR_OTHER_MODELS_BUCKET_NAME
}
