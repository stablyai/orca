/** Why: live PaneManager ids are still 1-based numeric handles even though
 *  durable pane keys use UUID leaf ids. Keep the first numeric id centralized
 *  for runtime-title mapping and legacy migration fallbacks. */
export const FIRST_PANE_ID = 1
