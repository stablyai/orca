import { collectDeferredMountTabIds } from './background-terminal-worktree-mount'

export function restrictTerminalTabsToHostSnapshot(opts: {
  restrictions: Map<string, ReadonlySet<string>>
  deferredMountTabIdsByWorktree: Map<string, ReadonlySet<string>>
  worktreeId: string
  allTabIds: readonly string[]
  hostTabIds: readonly string[]
}): void {
  const hostTabIds = new Set(opts.hostTabIds)
  const current = opts.restrictions.get(opts.worktreeId)
  const restrictedTabIds = current
    ? new Set([...current].filter((tabId) => hostTabIds.has(tabId)))
    : hostTabIds
  opts.restrictions.set(opts.worktreeId, restrictedTabIds)

  const deferredTabIds = collectDeferredMountTabIds(restrictedTabIds, opts.allTabIds)
  if (deferredTabIds.size === 0) {
    opts.deferredMountTabIdsByWorktree.delete(opts.worktreeId)
  } else {
    opts.deferredMountTabIdsByWorktree.set(opts.worktreeId, deferredTabIds)
  }
}
