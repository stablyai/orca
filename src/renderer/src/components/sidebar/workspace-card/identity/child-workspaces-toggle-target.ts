import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import type { AppState } from '@/store/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getHoveredWorkspaceIdentity } from './hovered-workspace-identity'
import { computeRenderedSidebarRows } from '../../worktree-list/listing/rendered-sidebar-worktree-order'
import { getPublishedVisibleWorktreeShortcutTargets } from '../../worktree-list/listing/visible-worktrees'
import { computeVisibleWorktrees } from '../../worktree-list/listing/compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from '../../worktree-list/listing/visible-worktree-options-from-state'
import { getWorktreeLineageGroupKey } from '../../../../../../shared/sidebar-list/sections/group-keys'
import {
  getHostScopedWorktreeLineageInputs,
  getWorktreeLineageAncestors
} from '../../../../../../shared/sidebar-list/lineage/worktree-lineage-projection'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

type ChildWorkspacesToggleState = Pick<
  AppState,
  'activeWorkspaceExecutionHostId' | 'activeWorktreeId' | 'worktreeLineageById' | 'worktreesByRepo'
>
type HoverDocument = NonNullable<Parameters<typeof getHoveredWorkspaceIdentity>[0]>

function resolveTargetWorktree(
  state: ChildWorkspacesToggleState,
  doc: HoverDocument
): Worktree | undefined {
  const hovered = getHoveredWorkspaceIdentity(doc)
  if (hovered) {
    return getIndexedAllWorktrees(selectWorktreesByRepo(state)).find(
      (worktree) =>
        worktree.id === hovered.workspaceId &&
        getWorktreeHostIdentity(worktree) === hovered.hostIdentity
    )
  }
  return state.activeWorktreeId
    ? getWorktreeOnHostFromState(
        state,
        state.activeWorktreeId,
        state.activeWorkspaceExecutionHostId ?? undefined
      )
    : undefined
}

function getParentWorktree(
  state: ChildWorkspacesToggleState,
  target: Worktree
): Worktree | undefined {
  // Only non-archived rows on the same host can be rendered lineage children.
  const worktrees = getIndexedAllWorktrees(selectWorktreesByRepo(state)).filter(
    (worktree) => worktree.hostId === target.hostId && !worktree.isArchived
  )
  const { worktreeMap, lineageById } = getHostScopedWorktreeLineageInputs(
    worktrees,
    state.worktreeLineageById,
    target.hostId
  )
  return getWorktreeLineageAncestors(target, lineageById, worktreeMap)[0]
}

export function resolveChildWorkspacesToggleGroupKey(
  state: ChildWorkspacesToggleState,
  renderedChipKeys: ReadonlySet<string>,
  doc: HoverDocument = document
): string | null {
  const target = resolveTargetWorktree(state, doc)
  if (!target || target.isArchived) {
    return null
  }
  const ownKey = getWorktreeLineageGroupKey(target)
  if (renderedChipKeys.has(ownKey)) {
    return ownKey
  }
  const parent = getParentWorktree(state, target)
  const parentKey = parent ? getWorktreeLineageGroupKey(parent) : null
  return parentKey && renderedChipKeys.has(parentKey) ? parentKey : null
}

/** Uses mounted rows so temporary reveal and drag policies match the existing chip. */
export function getRenderedLineageChipKeys(state: AppState): Set<string> {
  const publishedTargets = getPublishedVisibleWorktreeShortcutTargets()
  if (publishedTargets !== null) {
    return new Set(
      publishedTargets.flatMap((target) => (target.lineageGroupKey ? [target.lineageGroupKey] : []))
    )
  }
  const visibleWorktrees = computeVisibleWorktrees(
    selectWorktreesByRepo(state),
    [],
    buildVisibleWorktreeOptionsFromState(state, getIndexedRepoMap(state.repos))
  )
  const keys = new Set<string>()
  for (const row of computeRenderedSidebarRows(state, visibleWorktrees)) {
    if (row.type === 'item' && row.lineageGroupKey && row.lineageChildCount > 0) {
      keys.add(row.lineageGroupKey)
    }
  }
  return keys
}
