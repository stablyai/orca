import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { setTerminalPrewarmWorktrees } from '@/components/terminal/terminal-worktree-prewarm'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import { resolveCycledWorkspaceRow } from '../../worktree-keyboard-cycle'

// Settle first so prewarm never competes with the switch that just happened or a key-repeat scan.
const NEIGHBOR_PREWARM_DELAY_MS = 500

/** Keep the workspaces one keyboard step away warm, so stepping lands on a live surface. */
export function useWorkspaceNeighborPrewarm(args: {
  rows: HostSectionRow[]
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}): void {
  const { rows, pinnedDisplayPolicy, activeWorktreeId, activeWorkspaceExecutionHostId } = args
  useEffect(() => {
    if (activeWorktreeId === null) {
      setTerminalPrewarmWorktrees('neighbor', [])
      return
    }
    const timer = window.setTimeout(() => {
      const { worktreeNavHistory, worktreeNavHistoryIndex } = useAppStore.getState()
      const neighborIds = new Set<string>()
      for (const direction of ['up', 'down'] as const) {
        const row = resolveCycledWorkspaceRow({
          rows,
          pinnedDisplayPolicy,
          activeWorktreeId,
          activeWorkspaceExecutionHostId,
          lastActiveWorkspace: null,
          navHistory: worktreeNavHistory,
          navHistoryIndex: worktreeNavHistoryIndex,
          direction
        })
        // Remote remounts replay snapshots over the network; a speculative neighbor stays local-only.
        if (
          row &&
          row.worktree.id !== activeWorktreeId &&
          parseExecutionHostId(getWorktreeExecutionHostId(row.worktree, row.repo))?.kind === 'local'
        ) {
          neighborIds.add(row.worktree.id)
        }
      }
      setTerminalPrewarmWorktrees('neighbor', [...neighborIds])
    }, NEIGHBOR_PREWARM_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [rows, pinnedDisplayPolicy, activeWorktreeId, activeWorkspaceExecutionHostId])
  useEffect(() => () => setTerminalPrewarmWorktrees('neighbor', []), [])
}
