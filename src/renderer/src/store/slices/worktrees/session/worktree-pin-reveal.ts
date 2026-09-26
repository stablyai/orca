import type {
  WorktreeMetaBatchUpdate,
  WorktreePinTarget,
  WorktreeSlice
} from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getActiveSidebarWorkspaceId,
  parseWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import {
  getCyclicWorktreeLineageChildIds,
  isValidResolvedWorktreeLineageEdge
} from '../../../../../../shared/resolved-worktree-lineage'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

type WorktreeWithEmbeddedLineage = Worktree & { lineage?: WorktreeLineage | null }
function getProjectedLineage(get: WorktreeSliceGet, worktree: Worktree): WorktreeLineage | null {
  if (Object.hasOwn(get().worktreeLineageById, worktree.id)) {
    return get().worktreeLineageById[worktree.id] ?? null
  }
  return (worktree as WorktreeWithEmbeddedLineage).lineage ?? null
}

function hasChangedLineageAncestor(
  get: WorktreeSliceGet,
  worktreeId: string,
  changedWorktreeIds: ReadonlySet<string>
): boolean {
  const seen = new Set<string>()
  const validLineageByChildId = new Map<string, WorktreeLineage>()
  let child = get().getKnownWorktreeById(worktreeId)
  while (child && !seen.has(child.id)) {
    seen.add(child.id)
    const lineage = getProjectedLineage(get, child)
    const parent = lineage ? get().getKnownWorktreeById(lineage.parentWorktreeId) : null
    if (!lineage || !parent || !isValidResolvedWorktreeLineageEdge(child, parent, lineage)) {
      break
    }
    validLineageByChildId.set(child.id, lineage)
    child = parent
  }
  const cyclicIds = getCyclicWorktreeLineageChildIds(validLineageByChildId)
  child = get().getKnownWorktreeById(worktreeId)
  while (child && !cyclicIds.has(child.id)) {
    const lineage = getProjectedLineage(get, child)
    const parent = lineage ? get().getKnownWorktreeById(lineage.parentWorktreeId) : null
    if (!lineage || !parent || !isValidResolvedWorktreeLineageEdge(child, parent, lineage)) {
      return false
    }
    if (changedWorktreeIds.has(parent.id)) {
      return true
    }
    child = parent
  }
  return false
}

function resolvePinTarget(target: WorktreePinTarget): {
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
} {
  return typeof target === 'string'
    ? { worktreeId: target, executionHostId: undefined }
    : { worktreeId: target.worktreeId, executionHostId: target.executionHostId }
}

export function createSetWorktreesPinnedAndReveal(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['setWorktreesPinnedAndReveal'] {
  return (targets, isPinned) => {
    // Only follow a toggled row with the viewport when it's the focused worktree, not an unfocused card.
    const activeSidebarWorktreeId = getActiveSidebarWorkspaceId(
      get().activeWorkspaceKey,
      get().activeWorktreeId
    )
    // Skip worktrees already in the target state so a no-op toggle doesn't scroll the viewport away.
    const updates: WorktreeMetaBatchUpdate[] = []
    const changedWorktreeIds = new Set<string>()
    let didChange = false
    let revealWorktreeId: string | null = null
    for (const target of targets) {
      const { worktreeId, executionHostId: targetExecutionHostId } = resolvePinTarget(target)
      // A bare id (the legacy call shape) resolves against ANY host, same as before this
      // fix; a caller passing executionHostId disambiguates a Worktree.id two hosts share.
      const current = get().getKnownWorktreeById(worktreeId, targetExecutionHostId)
      if (!current || current.isPinned === isPinned) {
        continue
      }
      didChange = true
      changedWorktreeIds.add(worktreeId)
      const executionHostId = targetExecutionHostId ?? current.hostId ?? 'local'
      const workspaceScope = parseWorkspaceKey(worktreeId)
      if (workspaceScope?.type === 'folder') {
        void get().updateWorktreeMeta(worktreeId, { isPinned }, { executionHostId })
      } else {
        updates.push({
          worktreeId,
          updates: { isPinned },
          executionHostId
        })
      }
      if (revealWorktreeId === null && worktreeId === activeSidebarWorktreeId) {
        revealWorktreeId = worktreeId
      }
    }
    if (!didChange) {
      return
    }
    if (
      revealWorktreeId === null &&
      activeSidebarWorktreeId !== null &&
      get().settings?.showPinnedWorktreesInGroups !== true &&
      hasChangedLineageAncestor(get, activeSidebarWorktreeId, changedWorktreeIds)
    ) {
      revealWorktreeId = activeSidebarWorktreeId
    }
    // updateWorktreesMeta applies the store update synchronously, so the reveal below sees the row already rendered.
    if (updates.length > 0) {
      void get().updateWorktreesMeta(updates)
    }
    if (revealWorktreeId !== null) {
      get().revealWorktreeInSidebar(revealWorktreeId, { behavior: 'smooth', highlight: true })
    }
  }
}
