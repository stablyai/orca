import type { TerminalTab } from '../../../../shared/types'

export function shouldDeferActivationTerminalSpawn(args: {
  tab: Pick<TerminalTab, 'id' | 'pendingActivationSpawn' | 'ptyId'>
  ptyIdsByTabId: Record<string, string[]>
  hasQueuedLaunch: boolean
}): boolean {
  if (!args.tab.pendingActivationSpawn || args.hasQueuedLaunch) {
    return false
  }
  const livePtyIds = args.ptyIdsByTabId[args.tab.id] ?? []
  if (args.tab.ptyId === null) {
    return true
  }
  // Why: clicking a restored worktree with only a stale PTY id would otherwise
  // start a fresh login shell. Reattach live PTYs, but defer dead ones.
  return !livePtyIds.includes(args.tab.ptyId)
}
