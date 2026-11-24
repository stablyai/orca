import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  isTerminalLeafId,
  makePaneKey,
  parsePaneKey
} from '../../../../shared/workspace-layout/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { currentWorkerLineage } from '../../../../shared/orchestration/workers/worker-tab-stamp'

const paneKeys = new WeakMap<Tab, string | null>()

export function workerTabStopRequiresHome(tab: Pick<Tab, 'workerTab'>): boolean {
  return Boolean(tab.workerTab && currentWorkerLineage(tab.workerTab).stopRequiresHome)
}

/** The pane key of the worker surface in a stamped tab: its worker leaf, or the chat itself. */
export function workerTabPaneKey(tab: Tab): string | null {
  if (!tab.workerTab) {
    return null
  }
  const cached = paneKeys.get(tab)
  if (cached !== undefined) {
    return cached
  }
  const leafId = tab.workerTab.current?.workerLeafId ?? tab.workerTab.origin.workerLeafId
  const key =
    tab.contentType === 'agent-session'
      ? structuredAgentSessionPaneKey(tab.id, tab.entityId)
      : leafId && isTerminalLeafId(leafId)
        ? makePaneKey(tab.entityId, leafId)
        : null
  paneKeys.set(tab, key)
  return key
}

/** The live orchestration context for the tab's worker pane, when the projection still has it. */
export function workerTabContext(
  state: Pick<AppState, 'runtimeAgentOrchestrationByPaneKey'> &
    Partial<Pick<AppState, 'agentStatusByPaneKey'>>,
  tab: Tab
): AgentStatusOrchestrationContext | undefined {
  const paneKey = workerTabPaneKey(tab)
  if (!tab.workerTab) {
    for (const key in state.runtimeAgentOrchestrationByPaneKey) {
      const pane = parsePaneKey(key)
      const context = state.runtimeAgentOrchestrationByPaneKey[key]
      if (
        context?.coordinatorIdentity &&
        (pane?.tabId === tab.id || pane?.tabId === tab.entityId)
      ) {
        return context
      }
    }
    for (const [key, entry] of state.agentStatusByPaneKey ?? []) {
      const pane = parsePaneKey(key)
      const context = entry.orchestration
      if (
        context?.coordinatorIdentity &&
        (pane?.tabId === tab.id || pane?.tabId === tab.entityId)
      ) {
        return context
      }
    }
    return undefined
  }
  const context = paneKey
    ? (state.runtimeAgentOrchestrationByPaneKey[paneKey] ??
      state.agentStatusByPaneKey?.get(paneKey)?.orchestration)
    : undefined
  const dispatchId = tab.workerTab?.current?.dispatchId ?? tab.workerTab?.origin.dispatchId
  return context?.dispatchId === dispatchId ? context : undefined
}

/** Known running: the worker pane's own live context says its Dispatch is still open. */
export function isWorkerTabKnownRunning(
  state: Pick<AppState, 'runtimeAgentOrchestrationByPaneKey'> &
    Partial<Pick<AppState, 'agentStatusByPaneKey'>>,
  tab: Tab
): boolean {
  const status = workerTabContext(state, tab)?.dispatchStatus
  return status === 'pending' || status === 'dispatched'
}

/** Known finished: the worker pane's own live context reports a settled Dispatch. */
export function isWorkerTabKnownFinished(
  state: Pick<AppState, 'runtimeAgentOrchestrationByPaneKey'> &
    Partial<Pick<AppState, 'agentStatusByPaneKey'>>,
  tab: Tab
): boolean {
  const context = workerTabContext(state, tab)
  const status = context?.dispatchStatus
  return (
    context?.stopped === true ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'circuit_broken'
  )
}
