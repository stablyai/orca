import type { WorktreeMetaBatchUpdate, WorktreeSlice } from '../../worktree-helpers'
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
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'

type WorktreeWithEmbeddedLineage = Worktree & { lineage?: WorktreeLineage | null }
function getProjectedLineage(get: WorktreeSliceGet, worktree: Worktree): WorktreeLineage | null {
  if (Object.hasOwn(get().worktreeLineageById, worktree.id)) {
    return get().worktreeLineageById[worktree.id] ?? null
  }
  return (worktree as WorktreeWithEmbeddedLineage).lineage ?? null
}

// Lineage never crosses hosts: resolve parents on the child's host and match by host identity.
function hasChangedLineageAncestor(
  get: WorktreeSliceGet,
  activeWorktree: Worktree,
  changedIdentities: ReadonlySet<string>
): boolean {
  const seen = new Set<string>()
  const validLineageByChildId = new Map<string, WorktreeLineage>()
  let child: Worktree | undefined = activeWorktree
  while (child && !seen.has(child.id)) {
    seen.add(child.id)
    const lineage = getProjectedLineage(get, child)
    const parent = lineage
      ? get().getKnownWorktreeById(lineage.parentWorktreeId, child.hostId)
      : null
    if (!lineage || !parent || !isValidResolvedWorktreeLineageEdge(child, parent, lineage)) {
      break
    }
    validLineageByChildId.set(child.id, lineage)
    child = parent
  }
  const cyclicIds = getCyclicWorktreeLineageChildIds(validLineageByChildId)
  child = activeWorktree
  while (child && !cyclicIds.has(child.id)) {
    const lineage = getProjectedLineage(get, child)
    const parent = lineage
      ? get().getKnownWorktreeById(lineage.parentWorktreeId, child.hostId)
      : null
    if (!lineage || !parent || !isValidResolvedWorktreeLineageEdge(child, parent, lineage)) {
      return false
    }
    if (changedIdentities.has(getWorktreeHostIdentity(parent))) {
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
  return (targets, isPinned) => {
    // Only follow a toggled row with the viewport when it's the focused worktree, not an unfocused card.
    const activeSidebarWorktreeId = getActiveSidebarWorkspaceId(
      get().activeWorkspaceKey,
      get().activeWorktreeId
    )
    const activeExecutionHostId = get().activeWorkspaceExecutionHostId
    // Skip worktrees already in the target state so a no-op toggle doesn't scroll the viewport away.
    const updates: WorktreeMetaBatchUpdate[] = []
    const changedIdentities = new Set<string>()
    let didChange = false
    let revealTarget: Worktree | null = null
    for (const target of targets) {
      const worktreeId = typeof target === 'string' ? target : target.worktreeId
      const current =
        typeof target === 'string'
          ? get().getKnownWorktreeById(worktreeId)
          : get().getKnownWorktreeById(worktreeId, target.executionHostId)
      if (!current || current.isPinned === isPinned) {
        continue
      }
      didChange = true
      changedIdentities.add(getWorktreeHostIdentity(current))
      const workspaceScope = parseWorkspaceKey(worktreeId)
      if (workspaceScope?.type === 'folder') {
        void get().updateWorktreeMeta(
          worktreeId,
          { isPinned },
          { executionHostId: current.hostId ?? 'local' }
        )
      } else {
        updates.push({
          worktreeId,
          updates: { isPinned },
          executionHostId: current.hostId ?? 'local'
        })
      }
      // Only follow a row the active host owns, or a changed remote twin would scroll the viewport
      // to its local namesake. Alias check, not id compare: a paired-HUB row keeps its SSH hostId.
      if (
        revealTarget === null &&
        worktreeId === activeSidebarWorktreeId &&
        (activeExecutionHostId === null ||
          isExecutionHostAliasForWorktree(activeExecutionHostId, current))
      ) {
        revealTarget = current
      }
    }
    if (!didChange) {
      return
    }
    if (
      revealTarget === null &&
      activeSidebarWorktreeId !== null &&
      get().settings?.showPinnedWorktreesInGroups !== true
    ) {
      const activeWorktree = get().getKnownWorktreeById(
        activeSidebarWorktreeId,
        activeExecutionHostId ?? undefined
      )
      if (activeWorktree && hasChangedLineageAncestor(get, activeWorktree, changedIdentities)) {
        revealTarget = activeWorktree
      }
    }
    // updateWorktreesMeta applies the store update synchronously, so the reveal below sees the row already rendered.
    if (updates.length > 0) {
      void get().updateWorktreesMeta(updates)
    }
    if (revealTarget !== null) {
      // The row's own hostId, not the active alias: sidebar rows are keyed by their physical host.
      get().revealWorktreeInSidebar(revealTarget.id, {
        behavior: 'smooth',
        highlight: true,
        ...(revealTarget.hostId ? { executionHostId: revealTarget.hostId } : {})
      })
    }
  }
}
