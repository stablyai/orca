import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { resolvePaneWslDistro } from './terminal-pane-wsl-distro'

export type PaneClaudeTarget = { runtime: 'host' } | { runtime: 'wsl'; wslDistro: string }

/** The runtime a pane's shell runs in; null when its tab or workspace is unknown. */
export function paneClaudeTarget(tabId: string): PaneClaudeTarget | null {
  const state = useAppStore.getState()
  const tab = Object.values(state.unifiedTabsByWorktree)
    .flat()
    .find((candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId)
  if (!tab) {
    return null
  }
  if (tab.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return { runtime: 'host' }
  }
  const worktree = state.allWorktrees().find((candidate) => candidate.id === tab.worktreeId)
  if (!worktree) {
    return null
  }
  const wslDistro = resolvePaneWslDistro(state, worktree.id, worktree.path)
  return wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
}
