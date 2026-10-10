import {
  setWorktreeNavActivator,
  setWorktreeNavViewActivator
} from '@/store/slices/worktree-nav-history'
import type { WorktreeNavHistoryViewEntry } from '@/store/slices/worktree-nav-history'

type ActivateFn = (worktreeId: string, opts: { navigationIntent: 'user-open' }) => unknown
type ViewActivateFn = (entry: WorktreeNavHistoryViewEntry) => void

export function registerWorktreeActivation(
  activate: ActivateFn,
  activateView: ViewActivateFn
): void {
  // Why: back/forward is the user reopening a workspace they chose, like a sidebar click.
  setWorktreeNavActivator((worktreeId) => activate(worktreeId, { navigationIntent: 'user-open' }))
  setWorktreeNavViewActivator(activateView)
}
