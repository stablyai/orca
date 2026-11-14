import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { isAgentSubjectUnread } from '@/attention/agent-attention-acknowledgement'
import type { AppState } from '@/store/types'
import type { AgentStatusProjection } from '@/store/slices/agent-status/agent-status-projection'
import { recordChangeReaches } from '@/store/keyed-record-change-reads'
import {
  readAgentRowTurnRecords,
  type AgentRowUnreadState
} from '@/components/dashboard/dashboard-row-bucket'

export function selectAgentRowsUnread(
  state: AgentRowUnreadState,
  agents: readonly Pick<DashboardAgentRow, 'paneKey'>[]
): boolean[] {
  const records = readAgentRowTurnRecords(state)
  return agents.map((agent) => isAgentSubjectUnread(records, agent.paneKey))
}

/**
 * Unread per root key, re-read only when the roots, their workspace's projected rows, or one of
 * their acknowledgements change; other workspaces' writes return the previous result unread.
 */
export function createRootsUnreadSelector(worktreeId: string) {
  let roots: readonly string[] | undefined
  let projection: AgentStatusProjection | undefined
  let revision = 0
  let acknowledgements: AppState['acknowledgedAgentsByPaneKey'] | undefined
  let rootKeys: ReadonlySet<string> = new Set()
  let result: boolean[] = []
  const readsKey = (key: string): boolean => rootKeys.has(key)
  return (
    state: Pick<AppState, 'agentStatusByPaneKey' | 'acknowledgedAgentsByPaneKey'>,
    nextRoots: readonly string[]
  ): boolean[] => {
    const nextProjection = state.agentStatusByPaneKey.projection
    const nextRevision = nextProjection.revision(worktreeId)
    const unchanged =
      nextRoots === roots &&
      nextProjection === projection &&
      nextRevision === revision &&
      !recordChangeReaches(state.acknowledgedAgentsByPaneKey, acknowledgements, readsKey)
    acknowledgements = state.acknowledgedAgentsByPaneKey
    if (unchanged) {
      return result
    }
    roots = nextRoots
    projection = nextProjection
    revision = nextRevision
    rootKeys = new Set(nextRoots)
    const next = selectAgentRowsUnread(
      state,
      nextRoots.map((paneKey) => ({ paneKey }))
    )
    if (next.length !== result.length || next.some((value, index) => value !== result[index])) {
      result = next
    }
    return result
  }
}
