import { useAppStore } from '@/store'
import {
  getAllWorktreesFromState,
  getRepoMapFromState,
  getWorktreeMapFromState
} from '@/store/selectors'
import { EMPTY_REPO_MAP, EMPTY_WORKTREE_MAP, EMPTY_WORKTREES } from './worktree-context-menu-policy'

// Closed menus select stable empties so rank or catalog churn cannot wake every mounted row menu.
export function useMenuScopedWorktreeCatalog(menuOpen: boolean) {
  // Check first so closed menus never rebuild the shared catalog indexes.
  const repoMap = useAppStore((s) => (menuOpen ? getRepoMapFromState(s) : EMPTY_REPO_MAP))
  const worktreeMap = useAppStore((s) =>
    menuOpen ? getWorktreeMapFromState(s) : EMPTY_WORKTREE_MAP
  )
  const allWorktrees = useAppStore((s) =>
    menuOpen ? getAllWorktreesFromState(s) : EMPTY_WORKTREES
  )
  return { repoMap, worktreeMap, allWorktrees }
}
