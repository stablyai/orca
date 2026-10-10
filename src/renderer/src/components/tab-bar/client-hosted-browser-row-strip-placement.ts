/**
 * Which split group shows a worktree's client-hosted rows.
 *
 * Every group renders its own strip, so without one designated owner the same row would appear
 * once per split. The first group is chosen because it is stable: unlike the focused group it does
 * not move as the user clicks around, so a row never hops strips underneath them.
 */
export function resolveClientHostedBrowserRowStripGroupId(
  groups: readonly { id: string }[]
): string | null {
  return groups[0]?.id ?? null
}
