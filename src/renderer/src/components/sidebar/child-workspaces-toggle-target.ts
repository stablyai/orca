import {
  getAllWorktreesFromState,
  getRepoMapFromState,
  getWorktreeOnHostFromState
} from '@/store/selectors'
import type { AppState } from '@/store/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { getHoveredWorkspaceIdentity } from './hovered-workspace-delete'
import { computeRenderedSidebarRows } from './rendered-sidebar-worktree-order'
import {
  computeVisibleWorktrees,
  getPublishedVisibleWorktreeShortcutTargets
} from './visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from './visible-worktree-options-from-state'
import { getWorktreeLineageGroupKey } from './worktree-list/grouping/group-keys'
import {
  getHostScopedWorktreeLineageInputs,
  getWorktreeLineageAncestors
} from './worktree-lineage-projection'

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
    // Why: the card under the pointer wins over the active one, like the delete shortcut.
    return getAllWorktreesFromState(state).find(
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
  // Why: the sidebar nests a child only under a parent on the same host, and archived rows never render.
  const worktrees = getAllWorktreesFromState(state).filter(
    (worktree) => worktree.hostId === target.hostId && !worktree.isArchived
  )
  const { worktreeMap, lineageById } = getHostScopedWorktreeLineageInputs(
    worktrees,
    state.worktreeLineageById,
    target.hostId
  )
  return getWorktreeLineageAncestors(target, lineageById, worktreeMap)[0]
}

/** Resolves the target's rendered chip, falling back to its same-host parent's chip. */
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
    state.worktreesByRepo,
    [],
    buildVisibleWorktreeOptionsFromState(state, getRepoMapFromState(state))
  )
  const keys = new Set<string>()
  for (const row of computeRenderedSidebarRows(state, visibleWorktrees)) {
    if (row.type === 'item' && row.lineageGroupKey && row.lineageChildCount > 0) {
      keys.add(row.lineageGroupKey)
    }
  }
  return keys
}
