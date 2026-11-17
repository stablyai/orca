import { useMemo } from 'react'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { useAppStore } from '@/store'
import {
  getIndexedAllWorktrees,
  getIndexedWorktreeMap
} from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { EMPTY_REPO_MAP, EMPTY_WORKTREE_MAP, EMPTY_WORKTREES } from './worktree-context-menu-policy'

// Closed menus select stable empties so rank or catalog churn cannot wake every mounted row menu.
export function useMenuScopedWorktreeCatalog(menuOpen: boolean) {
  // Check first so closed menus never rebuild the shared catalog indexes.
  const repoMap = useAppStore((s) => (menuOpen ? getIndexedRepoMap(s.repos) : EMPTY_REPO_MAP))
  const worktreesByRepo = useAppStore((s) => (menuOpen ? selectWorktreesByRepo(s) : null))
  // A title write updates the shared indexes in place; an open menu takes its own list per store write.
  const allWorktrees = useMemo(
    () => (worktreesByRepo ? [...getIndexedAllWorktrees(worktreesByRepo)] : EMPTY_WORKTREES),
    [worktreesByRepo]
  )
  const worktreeMap = worktreesByRepo ? getIndexedWorktreeMap(worktreesByRepo) : EMPTY_WORKTREE_MAP
  return { repoMap, worktreeMap, allWorktrees }
}
