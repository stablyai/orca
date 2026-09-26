import type { WorktreeMetaBatchUpdate, WorktreeSlice } from '../../worktree-helpers'
import type { AppState } from '../../../types'
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
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

type WorktreeWithEmbeddedLineage = Worktree & { lineage?: WorktreeLineage | null }
type WorktreePinRevealState = {
  activeWorkspaceKey: AppState['activeWorkspaceKey']
  activeWorktreeId: AppState['activeWorktreeId']
  activeWorkspaceExecutionHostId: AppState['activeWorkspaceExecutionHostId']
  worktreeLineageById: AppState['worktreeLineageById']
  settings: Pick<NonNullable<AppState['settings']>, 'showPinnedWorktreesInGroups'> | null
  getKnownWorktreeById: AppState['getKnownWorktreeById']
  updateWorktreeMeta: AppState['updateWorktreeMeta']
  updateWorktreesMeta: AppState['updateWorktreesMeta']
  revealWorktreeInSidebar: AppState['revealWorktreeInSidebar']
}
type WorktreePinRevealGet = () => WorktreePinRevealState

function getProjectedLineage(
  get: WorktreePinRevealGet,
  worktree: Worktree
): WorktreeLineage | null {
  if (Object.hasOwn(get().worktreeLineageById, worktree.id)) {
    return get().worktreeLineageById[worktree.id] ?? null
  }
  return (worktree as WorktreeWithEmbeddedLineage).lineage ?? null
}

function hasChangedLineageAncestor(
  get: WorktreePinRevealGet,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  changedWorktreeIdentities: ReadonlySet<string>
): boolean {
  const seen = new Set<string>()
  const validLineageByChildId = new Map<string, WorktreeLineage>()
  let child = get().getKnownWorktreeById(worktreeId, executionHostId)
  while (child && !seen.has(child.id)) {
    seen.add(child.id)
    const lineage = getProjectedLineage(get, child)
    const parent = lineage
      ? get().getKnownWorktreeById(
          lineage.parentWorktreeId,
          child.hostId ?? LOCAL_EXECUTION_HOST_ID
        )
      : null
    if (!lineage || !parent || !isValidResolvedWorktreeLineageEdge(child, parent, lineage)) {
      break
    }
    validLineageByChildId.set(child.id, lineage)
    child = parent
  }
  const cyclicIds = getCyclicWorktreeLineageChildIds(validLineageByChildId)
  child = get().getKnownWorktreeById(worktreeId, executionHostId)
  while (child && !cyclicIds.has(child.id)) {
    const lineage = getProjectedLineage(get, child)
    const parent = lineage
      ? get().getKnownWorktreeById(
          lineage.parentWorktreeId,
          child.hostId ?? LOCAL_EXECUTION_HOST_ID
        )
      : null
    if (!lineage || !parent || !isValidResolvedWorktreeLineageEdge(child, parent, lineage)) {
      return false
    }
    if (changedWorktreeIdentities.has(getWorktreeHostIdentity(parent))) {
      return true
    }
    child = parent
  }
  return false
}

export function createSetWorktreesPinnedAndReveal(
  get: WorktreePinRevealGet
): WorktreeSlice['setWorktreesPinnedAndReveal'] {
  return (targets, isPinned) => {
    // Only follow a toggled row with the viewport when it's the focused worktree, not an unfocused card.
    const activeSidebarWorktreeId = getActiveSidebarWorkspaceId(
      get().activeWorkspaceKey,
      get().activeWorktreeId
    )
    // Skip worktrees already in the target state so a no-op toggle doesn't scroll the viewport away.
    const updates: WorktreeMetaBatchUpdate[] = []
    const changedWorktreeIdentities = new Set<string>()
    let didChange = false
    let revealWorktreeId: string | null = null
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
      changedWorktreeIdentities.add(getWorktreeHostIdentity(current))
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
      // The active id carries no host, so a changed remote twin would otherwise scroll the
      // viewport to its local namesake; only follow a row the active host actually owns.
      const activeExecutionHostId = get().activeWorkspaceExecutionHostId
      if (
        revealWorktreeId === null &&
        worktreeId === activeSidebarWorktreeId &&
        (activeExecutionHostId === null || (current.hostId ?? 'local') === activeExecutionHostId)
      ) {
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
        get().activeWorkspaceExecutionHostId ?? undefined,
        changedWorktreeIdentities
      )
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
