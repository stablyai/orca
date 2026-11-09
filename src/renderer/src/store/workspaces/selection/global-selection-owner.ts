// Global selection projects only the active workspace; retained/floating workspaces write their own maps without moving it.
export function ownsGlobalSelection(
  state: { activeWorktreeId: string | null },
  worktreeId: string | null
): boolean {
  return worktreeId === state.activeWorktreeId
}
