import { shallow } from 'zustand/shallow'
import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { applyAgentRowLineage } from '@/components/dashboard/rows/agent-row-lineage'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { reuseArrayIfEqual } from './worktree-agent-row-selectors'
import { createWorktreeAgentHostOwnership } from './worktree-agent-host-ownership'

export const EMPTY_AGENT_ROWS: DashboardAgentRow[] = []

function reuseUnchangedRows(previous: DashboardAgentRow[], next: DashboardAgentRow[]) {
  const byPaneKey = new Map(previous.map((row) => [row.paneKey, row]))
  return reuseArrayIfEqual(
    previous,
    next.map((row) => {
      const old = byPaneKey.get(row.paneKey)
      return old &&
        shallow(old.tab, row.tab) &&
        shallow(old.lineage, row.lineage) &&
        shallow({ ...old, tab: row.tab, lineage: row.lineage }, row)
        ? old
        : row
    })
  )
}

/** The row model shared by mounted cards and hidden-workspace summaries. */
export function createWorktreeAgentRowsSelector(worktreeId: string, hostId?: ExecutionHostId) {
  const ownership = hostId ? createWorktreeAgentHostOwnership(worktreeId, hostId) : null
  let previous: DashboardAgentRow[] | undefined
  let result = EMPTY_AGENT_ROWS
  return (state: AppState): DashboardAgentRow[] => {
    // The keyed projection owns the workspace's rows; a host only filters them.
    const rows = state.agentStatusByPaneKey.projection.list(worktreeId)
    if (!ownership || rows.length === 0) {
      previous = rows
      result = rows
      return rows
    }
    if (rows === previous && !ownership.stale(state)) {
      return result
    }
    previous = rows
    const owned = rows.filter(ownership.record(state, rows))
    // Same-ID twins on another host are rare; an unfiltered list keeps the projection's rows.
    result =
      owned.length === rows.length
        ? rows
        : // Re-lineage clones every row, so keep unchanged ones for card memos.
          reuseUnchangedRows(result, applyAgentRowLineage(owned))
    return result
  }
}

/** Root keys a host-scoped card renders; returns `keys` itself while every row is on the host. */
export function createWorktreeAgentHostKeysSelector(worktreeId: string, hostId: ExecutionHostId) {
  const ownership = createWorktreeAgentHostOwnership(worktreeId, hostId)
  let prevKeys: readonly string[] | undefined
  let prevProjection: AppState['agentStatusByPaneKey']['projection'] | undefined
  let prevRevision = -1
  let result: readonly string[] = []
  return (state: AppState, keys: readonly string[]): readonly string[] => {
    const projection = state.agentStatusByPaneKey.projection
    const revision = projection.revision(worktreeId)
    if (keys.length === 0) {
      prevKeys = keys
      prevProjection = projection
      prevRevision = revision
      result = keys
      return keys
    }
    // Any row change in this workspace moves its revision, so unchanged roots are not read.
    if (
      prevKeys === keys &&
      prevProjection === projection &&
      prevRevision === revision &&
      !ownership.stale(state)
    ) {
      return result
    }
    prevKeys = keys
    prevProjection = projection
    prevRevision = revision
    const rows = keys.map((key) => projection.row(key))
    const belongs = ownership.record(state, rows)
    const owned = keys.filter((_, index) => {
      const row = rows[index]
      return !row || belongs(row)
    })
    result = owned.length === keys.length ? keys : owned
    return result
  }
}

const sharedSelectors = new Map<string, ReturnType<typeof createWorktreeAgentRowsSelector>>()
const SHARED_SELECTOR_LIMIT = 2048

/**
 * One live-store row selector per workspace and host, shared by the card's own rows and the
 * lineage rollup so a status change projects the rows once. Least recently used is evicted, so
 * workspaces still being read keep their memo above the cap.
 */
export function getSharedWorktreeAgentRowsSelector(worktreeId: string, hostId?: ExecutionHostId) {
  const key = `${hostId ?? ''}\n${worktreeId}`
  let selector = sharedSelectors.get(key)
  if (selector) {
    sharedSelectors.delete(key)
  } else {
    selector = createWorktreeAgentRowsSelector(worktreeId, hostId)
    if (sharedSelectors.size >= SHARED_SELECTOR_LIMIT) {
      sharedSelectors.delete(sharedSelectors.keys().next().value!)
    }
  }
  sharedSelectors.set(key, selector)
  return selector
}

/** Structural ownership, live status, and acknowledgements used by lineage summaries. */
export function worktreeAgentProjectionInputs(state: AppState): readonly unknown[] {
  return [
    state.tabsByWorktree,
    state.unifiedTabsByWorktree,
    state.migrationUnsupportedByPtyId,
    state.ptyIdsByTabId,
    state.terminalLayoutsByTabId,
    state.runtimeAgentOrchestrationByPaneKey,
    state.remoteAgentOrchestrationByHost,
    state.paneForegroundAgentByPaneKey,
    ...structuredAgentSessionOwnerInputs(state),
    state.runtimePaneTitlesByTabId,
    state.agentStatusByPaneKey,
    state.agentStatusEpoch,
    state.acknowledgedAgentsByPaneKey
  ]
}
