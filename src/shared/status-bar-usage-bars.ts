/**
 * Whether the status-bar usage meters draw their bar.
 *
 * Why it is a preference and not a constant: the bar, the percentage and the
 * reset countdown all describe the same headroom, and the status bar competes
 * for width with the resource, SSH and ports segments. Which of the three to
 * drop is a judgement about a given layout — a wide monitor has room for all
 * three, a narrow one does not — so it belongs to the user, not to us.
 *
 * Defaults to visible: the bar is what the status bar has always drawn, and a
 * preference that silently changes an existing layout on upgrade is worse than
 * one the user opts into.
 */
export const DEFAULT_STATUS_BAR_USAGE_BARS_VISIBLE = true

export function normalizeStatusBarUsageBarsVisible(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_STATUS_BAR_USAGE_BARS_VISIBLE
}
