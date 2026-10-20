import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  sortWorktreesByStamps,
  type SortBy
} from '../../../../../../shared/sidebar-list/smart-sort'
import { useReusedArrayIdentity } from './use-reused-array-identity'
import { useSidebarListSession } from '@/lib/sidebar-list-session'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

/**
 * The order is a pure read of the owning hosts' stamps on the rows, so a re-list is what re-sorts.
 * No settle window, latch, saved Smart order or create grace. Host identities, so a same-id pair on
 * two hosts keeps its own ranks.
 */
export function useSidebarWorktreeSortOrder(args: {
  repoMap: Map<string, Repo>
  sortBy: SortBy
}): string[] {
  const { repoMap, sortBy } = args
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const ranked = useMemo(
    () =>
      sortWorktreesByStamps(
        getAllWorktreesFromState({ worktreesByRepo }).filter((worktree) => !worktree.isArchived),
        sortBy,
        repoMap
      ).map(getWorktreeHostIdentity),
    [worktreesByRepo, repoMap, sortBy]
  )
  const sortedIds = useReusedArrayIdentity(ranked)
  // Why: main's sleeping retention lives as long as this list.
  useSidebarListSession()
  return sortedIds
}
