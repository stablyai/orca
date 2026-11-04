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
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getIndexedWorktreesById } from '../../../worktree-repo-index'
import { worktreeOwnerHostIds } from '@/lib/worktree-runtime-owner-index'
import { selectWorktreesByRepo } from '../../../workspace-record-selectors'

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
  changedWorktreeIds: ReadonlySet<string>,
  // The focused copy's host: its lineage walks that host's rows, never a same-id twin's.
  hostId: ExecutionHostId | undefined
): boolean {
  const seen = new Set<string>()
  const validLineageByChildId = new Map<string, WorktreeLineage>()
  let child = get().getKnownWorktreeById(worktreeId, hostId)
  while (child && !seen.has(child.id)) {
    seen.add(child.id)
    const lineage = getProjectedLineage(get, child)
    const parent = lineage ? get().getKnownWorktreeById(lineage.parentWorktreeId, hostId) : null
    if (!lineage || !parent || !isValidResolvedWorktreeLineageEdge(child, parent, lineage)) {
      break
    }
    validLineageByChildId.set(child.id, lineage)
    child = parent
  }
  const cyclicIds = getCyclicWorktreeLineageChildIds(validLineageByChildId)
  child = get().getKnownWorktreeById(worktreeId, hostId)
  while (child && !cyclicIds.has(child.id)) {
    const lineage = getProjectedLineage(get, child)
    const parent = lineage ? get().getKnownWorktreeById(lineage.parentWorktreeId, hostId) : null
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
  return (targets, isPinned) => {
    // Only follow a toggled row with the viewport when it's the focused worktree, not an unfocused card.
    const activeSidebarWorktreeId = getActiveSidebarWorkspaceId(
      get().activeWorkspaceKey,
      get().activeWorktreeId
    )
    // Why: a same-id twin on another host is not the focused card, so it must not scroll to it.
    const activeHostId = get().activeWorkspaceExecutionHostId ?? null
    // Skip worktrees already in the target state so a no-op toggle doesn't scroll the viewport away.
    const updates: WorktreeMetaBatchUpdate[] = []
    const changedWorktreeIds = new Set<string>()
    let didChange = false
    let revealWorktreeId: string | null = null
    for (const target of targets) {
      const worktreeId = target.id
      // Why: an id names every host's copy; without a host only a lone row is safe to write.
      const current =
        target.hostId ||
        getIndexedWorktreesById(selectWorktreesByRepo(get()), worktreeId).length <= 1
          ? get().getKnownWorktreeById(worktreeId, target.hostId)
          : undefined
      if (!current || current.isPinned === isPinned) {
        continue
      }
      const executionHostId = target.hostId ?? current.hostId ?? 'local'
      didChange = true
      // A server-proxied row answers to its own SSH host and to its server's runtime alias.
      const onFocusedHost =
        !activeHostId ||
        target.hostId === activeHostId ||
        worktreeOwnerHostIds(current).includes(activeHostId)
      if (onFocusedHost) {
        changedWorktreeIds.add(worktreeId)
      }
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
      if (revealWorktreeId === null && onFocusedHost && worktreeId === activeSidebarWorktreeId) {
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
      hasChangedLineageAncestor(
        get,
        activeSidebarWorktreeId,
        changedWorktreeIds,
        activeHostId ?? undefined
      )
    ) {
      revealWorktreeId = activeSidebarWorktreeId
    }
    // updateWorktreesMeta applies the store update synchronously, so the reveal below sees the row already rendered.
    if (updates.length > 0) {
      void get().updateWorktreesMeta(updates)
    }
    if (revealWorktreeId !== null) {
      // The focused row's own sidebar host, not the logical runtime alias the selection may hold.
      const revealHostId = activeHostId
        ? (get().getKnownWorktreeById(revealWorktreeId, activeHostId)?.hostId ?? activeHostId)
        : null
      get().revealWorktreeInSidebar(revealWorktreeId, {
        behavior: 'smooth',
        highlight: true,
        ...(revealHostId ? { executionHostId: revealHostId } : {})
      })
    }
  }
}
