import {
  setWorktreeNavActivator,
  setWorktreeNavViewActivator
} from '@/store/slices/worktree-nav-history'
import type { WorktreeNavHistoryViewEntry } from '@/store/slices/worktree-nav-history'

type ActivateFn = (worktreeId: string) => unknown
type ViewActivateFn = (entry: WorktreeNavHistoryViewEntry) => void

export function registerWorktreeActivation(
  activate: ActivateFn,
  activateView: ViewActivateFn
): void {
  setWorktreeNavActivator(activate)
  setWorktreeNavViewActivator(activateView)
}
