import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { Collection } from '../../../../../../shared/collection-types'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { buildCollectionRows } from '../../worktree-list-collections'

const EMPTY_COLLECTIONS: readonly Collection[] = []

// Why: collections are additive sections above every grouping mode, like Pinned.
export function useCollectionRows(
  args: Omit<Parameters<typeof buildCollectionRows>[0], 'collections'>
): Row[] {
  const collections = useAppStore((s) => s.collections ?? EMPTY_COLLECTIONS)
  const { worktrees, repoMap, collapsedGroups, repoOrder } = args
  return useMemo(
    () => buildCollectionRows({ collections, worktrees, repoMap, collapsedGroups, repoOrder }),
    [collections, worktrees, repoMap, collapsedGroups, repoOrder]
  )
}
