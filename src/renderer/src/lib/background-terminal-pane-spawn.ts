import { makePaneKey } from '../../../shared/stable-pane-id'
import type { Worktree } from '../../../shared/types'

export async function spawnBackgroundTerminalPane(args: {
  worktree: Worktree
  connectionId: string | null
  tabId: string
  leafId: string
  command?: string
  env?: Record<string, string>
}): Promise<{ id: string; spawnRetirementToken?: string }> {
  const result = await window.api.pty.spawn({
    cols: 120,
    rows: 40,
    cwd: args.worktree.path,
    ...(args.command ? { command: args.command } : {}),
    env: {
      ...args.env,
      ORCA_PANE_KEY: makePaneKey(args.tabId, args.leafId),
      ORCA_TAB_ID: args.tabId,
      ORCA_WORKTREE_ID: args.worktree.id
    },
    connectionId: args.connectionId,
    worktreeId: args.worktree.id,
    tabId: args.tabId,
    leafId: args.leafId
  })
  return { id: result.id, spawnRetirementToken: result.spawnRetirementToken }
}
