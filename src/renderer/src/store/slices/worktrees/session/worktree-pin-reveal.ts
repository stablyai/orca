import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  getActiveSidebarWorkspaceId,
  parseWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import {
  getCyclicWorktreeLineageChildIds,
  isValidResolvedWorktreeLineageEdge
} from '../../../../../../shared/resolved-worktree-lineage'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
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

export function createSetWorktreesPinnedAndReveal(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['setWorktreesPinnedAndReveal'] {
  return (worktreeIds, isPinned) => {
    // Only follow a toggled row with the viewport when it's the focused worktree, not an unfocused card.
    const activeSidebarWorktreeId = getActiveSidebarWorkspaceId(
      get().activeWorkspaceKey,
      get().activeWorktreeId
    )
    // Skip worktrees already in the target state so a no-op toggle doesn't scroll the viewport away.
    const updates = new Map<string, Partial<WorktreeMeta>>()
    const changedWorktreeIds = new Set<string>()
    let didChange = false
    let revealWorktreeId: string | null = null
    for (const worktreeId of worktreeIds) {
      const current = get().getKnownWorktreeById(worktreeId)
      if (!current || current.isPinned === isPinned) {
        continue
      }
      didChange = true
      changedWorktreeIds.add(worktreeId)
      const workspaceScope = parseWorkspaceKey(worktreeId)
      if (workspaceScope?.type === 'folder') {
        void get().updateWorktreeMeta(worktreeId, { isPinned })
      } else {
        updates.set(worktreeId, { isPinned })
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
    if (updates.size > 0) {
      void get().updateWorktreesMeta(updates)
    }
    if (revealWorktreeId !== null) {
      get().revealWorktreeInSidebar(revealWorktreeId, { behavior: 'smooth', highlight: true })
    }
  }
}
