import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectSidebarLineageParentIdentities } from '@/store/cross-store-lineage-parents'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo
} from '../../../../../../shared/sidebar-list/worktree-lineage-projection'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getEligibleWorktreeParents } from '../parenting/worktree-parent-candidates'
import {
  EMPTY_CROSS_STORE_LINEAGE_BY_STORE_KEY,
  EMPTY_CYCLIC_LINEAGE_IDS,
  hasWorktreeParentLink,
  selectMenuScopedMap
} from './worktree-context-menu-policy'

/** The menu's parent facts: its links (a parent on another machine included), the parent to open,
 * and how many parents Set Parent offers. Closed menus read empty maps. */
export function useMenuLineageParent(args: {
  menuOpen: boolean
  worktree: Worktree
  activeContextWorktrees: readonly Worktree[]
  allWorktrees: readonly Worktree[]
  worktreeMap: ReadonlyMap<string, Worktree>
  repoMap: ReadonlyMap<string, Pick<Repo, 'connectionId' | 'executionHostId'>>
  worktreeLineageById: AppState['worktreeLineageById']
  workspaceLineageByChildKey: AppState['workspaceLineageByChildKey']
}) {
  const { menuOpen, worktree, allWorktrees, worktreeMap, repoMap, worktreeLineageById } = args
  const crossStoreLineageByStoreKey = useAppStore((s) =>
    selectMenuScopedMap(
      menuOpen,
      s.crossStoreLineageByStoreKey,
      EMPTY_CROSS_STORE_LINEAGE_BY_STORE_KEY
    )
  )
  const parentIdentities = useAppStore((s) =>
    menuOpen ? selectSidebarLineageParentIdentities(s) : undefined
  )
  const hasLink = (item: Worktree): boolean =>
    hasWorktreeParentLink(
      item,
      worktreeLineageById,
      args.workspaceLineageByChildKey,
      crossStoreLineageByStoreKey
    )
  const cyclicLineageIds = useMemo(
    () =>
      menuOpen
        ? getCyclicProjectedWorktreeLineageIds(worktreeLineageById, worktreeMap)
        : EMPTY_CYCLIC_LINEAGE_IDS,
    [menuOpen, worktreeLineageById, worktreeMap]
  )
  // Path-derived IDs can be reused; require the same instance check as grouped-row parent navigation.
  const lineageInfo = useMemo(
    () => getLineageRenderInfo(worktree, worktreeLineageById, worktreeMap, cyclicLineageIds),
    [cyclicLineageIds, worktree, worktreeLineageById, worktreeMap]
  )
  const validParent = useMemo(() => {
    if (lineageInfo.state === 'valid') {
      return lineageInfo.parent
    }
    const parentIdentity = parentIdentities?.get(getWorktreeHostIdentity(worktree))
    return parentIdentity === undefined
      ? null
      : (allWorktrees.find((row) => getWorktreeHostIdentity(row) === parentIdentity) ?? null)
  }, [allWorktrees, lineageInfo, parentIdentities, worktree])
  const eligibleParentCount = useMemo(
    () =>
      menuOpen
        ? getEligibleWorktreeParents({
            child: worktree,
            worktrees: allWorktrees,
            lineageById: worktreeLineageById,
            worktreeMap,
            repoMap,
            cyclicLineageIds,
            parentIdentities
          }).length
        : 0,
    [
      allWorktrees,
      cyclicLineageIds,
      menuOpen,
      parentIdentities,
      repoMap,
      worktree,
      worktreeLineageById,
      worktreeMap
    ]
  )
  return {
    hasParentLink: hasLink(worktree),
    hasAnyContextLineage: args.activeContextWorktrees.some(hasLink),
    cyclicLineageIds,
    validParent,
    eligibleParentCount
  }
}
