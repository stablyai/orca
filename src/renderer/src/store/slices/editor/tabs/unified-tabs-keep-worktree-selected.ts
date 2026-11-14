/** True when a non-closed unified tab (for example a structured chat) still belongs to the worktree. */
export function unifiedTabsKeepWorktreeSelected(
  tabs: readonly { id: string; entityId: string }[] | undefined,
  closedIds: ReadonlySet<string>
): boolean {
  return (tabs ?? []).some((tab) => !closedIds.has(tab.id) && !closedIds.has(tab.entityId))
}
