import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { buildAttentionWorkspaceIds, type AttentionWorkspaceState } from './attention-workspaces'

const EMPTY_ATTENTION_WORKSPACE_IDS: ReadonlySet<string> = new Set()

// Why module scope rather than useShallow/useMemo: zustand runs the selector on every store write
// and re-renders the subscriber whenever the selected value's identity changes. Gating on the
// slices here allocates nothing on the unchanged path, and handing back the previous Set while
// membership holds keeps agent traffic that leaves the verdict unchanged from re-rendering the
// viewport at all. The result is a pure function of the state, so one cache serves every consumer.
let previousState: AttentionWorkspaceState | null = null
let verdictState: AttentionWorkspaceState | null = null
let verdictEpoch = -1
let verdictIds: ReadonlySet<string> = EMPTY_ATTENTION_WORKSPACE_IDS

/** Test-only: drop the cross-render caches so a case starts cold. */
export function resetAttentionWorkspaceIdsForTests(): void {
  previousState = null
  verdictState = null
  verdictEpoch = -1
  verdictIds = EMPTY_ATTENTION_WORKSPACE_IDS
}

function selectAttentionWorkspaceState(s: AppState): AttentionWorkspaceState {
  const previous = previousState
  if (
    previous !== null &&
    previous.agentStatusByPaneKey === s.agentStatusByPaneKey &&
    previous.folderWorkspaces === s.folderWorkspaces &&
    previous.migrationUnsupportedByPtyId === s.migrationUnsupportedByPtyId &&
    previous.tabsByWorktree === s.tabsByWorktree &&
    previous.ptyIdsByTabId === s.ptyIdsByTabId &&
    previous.runtimePaneTitlesByTabId === s.runtimePaneTitlesByTabId &&
    previous.terminalLayoutsByTabId === s.terminalLayoutsByTabId &&
    previous.unifiedTabsByWorktree === s.unifiedTabsByWorktree &&
    previous.worktreesByRepo === s.worktreesByRepo
  ) {
    return previous
  }
  previousState = {
    agentStatusByPaneKey: s.agentStatusByPaneKey,
    folderWorkspaces: s.folderWorkspaces,
    migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
    tabsByWorktree: s.tabsByWorktree,
    ptyIdsByTabId: s.ptyIdsByTabId,
    runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
    terminalLayoutsByTabId: s.terminalLayoutsByTabId,
    unifiedTabsByWorktree: s.unifiedTabsByWorktree,
    worktreesByRepo: s.worktreesByRepo
  }
  return previousState
}

function idsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false
    }
  }
  return true
}

function selectAttentionWorkspaceIds(s: AppState): ReadonlySet<string> {
  const state = selectAttentionWorkspaceState(s)
  // Why agentStatusEpoch: freshness is time-based, so a row can age out of attention with no
  // slice write at all. The epoch ticks at the stale boundary and re-derives the verdict.
  if (state === verdictState && s.agentStatusEpoch === verdictEpoch) {
    return verdictIds
  }
  // Why Date.now() is read here: freshness decay is tracked by the epoch above, matching how the
  // dashboard's counts treat their own generation.
  const ids = buildAttentionWorkspaceIds(state, Date.now())
  verdictIds = idsEqual(verdictIds, ids) ? verdictIds : ids
  verdictState = state
  verdictEpoch = s.agentStatusEpoch
  return verdictIds
}

/**
 * Workspaces whose agent waits on the user, for the collapsed-group count badge.
 *
 * `enabled` false selects nothing, so the badge setting's `off` mode subscribes to nothing that
 * agent traffic writes and cannot re-render the sidebar.
 *
 * The returned set keeps its identity while membership holds, and that identity is what the
 * store compares: agent traffic that leaves the verdict unchanged re-renders nothing.
 */
export function useAttentionWorkspaceIds(enabled: boolean): ReadonlySet<string> {
  return useAppStore((s) =>
    enabled ? selectAttentionWorkspaceIds(s) : EMPTY_ATTENTION_WORKSPACE_IDS
  )
}
