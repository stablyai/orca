import type { TerminalTab, WorkspaceSessionState } from '../../../shared/types'

export function buildSanitizedTabsByWorktree(
  tabsByWorktree: Record<string, TerminalTab[]>
): WorkspaceSessionState['tabsByWorktree'] {
  // Why: session:set persists without Zod re-parse, so renderer-only lifecycle flags must be stripped explicitly.
  return Object.fromEntries(
    Object.entries(tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const {
          pendingActivationSpawn: _pendingActivationSpawn,
          titleHydrationPending: _titleHydrationPending,
          ...rest
        } = tab
        void _pendingActivationSpawn
        void _titleHydrationPending
        return rest
      })
    ])
  )
}
