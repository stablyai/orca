/**
 * The global selection fields (active tab, file, browser tab and tab type) project the active
 * workspace. A selection in any other workspace — a retained worktree, or the floating panel on
 * screen beside the active one — lands only in that workspace's own maps.
 */
export function ownsGlobalSelection(
  state: { activeWorktreeId: string | null },
  worktreeId: string | null
): boolean {
  return worktreeId === state.activeWorktreeId
}
