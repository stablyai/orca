import {
  findWorktreeLineageRow,
  getWorktreeLineageIdentity,
  getWorktreeLineageProjection
} from '../../../../../../shared/sidebar-list/worktree-lineage-projection'
import type { WorktreeMetaBatchUpdate, WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  getActiveSidebarWorkspaceId,
  parseWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import { getLineageInputs } from '../../../../components/sidebar/visible-worktree-indexes'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getIndexedWorktreesById } from '../../../worktree-repo-index'
import { worktreeOwnerHostIds } from '@/lib/worktree-runtime-owner-index'
import { selectWorktreesByRepo } from '../../../workspace-record-selectors'

function hasChangedLineageAncestor(
  get: WorktreeSliceGet,
  worktreeId: string,
  changedWorktreeIdentities: ReadonlySet<string>,
  // The focused copy's host: its lineage walks that host's rows, never a same-id twin's.
  hostId: ExecutionHostId | undefined
): boolean {
  const state = get()
  const inputs = getLineageInputs(state)
  const { parents } = getWorktreeLineageProjection(inputs.lineageById, inputs.worktreeMap)
  let child = state.getKnownWorktreeById(worktreeId, hostId)
  if (child) {
    child = findWorktreeLineageRow(inputs.worktreeMap, child)
  }
  while (child) {
    const parent = parents.get(child)
    if (!parent) {
      break
    }
    if (changedWorktreeIdentities.has(getWorktreeLineageIdentity(parent))) {
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
    const changedWorktreeIdentities = new Set<string>()
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
      changedWorktreeIdentities.add(getWorktreeLineageIdentity(current))
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
        changedWorktreeIdentities,
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
