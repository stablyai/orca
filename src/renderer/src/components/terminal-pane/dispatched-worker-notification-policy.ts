import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'

type DispatchedWorkerPolicyState = {
  settings?: { notifications?: { dispatchedWorkerTaskComplete?: boolean } } | null
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  agentStatusByPaneKey?: Record<string, { orchestration?: AgentStatusOrchestrationContext }>
  retainedAgentsByPaneKey?: Record<
    string,
    { entry?: { orchestration?: AgentStatusOrchestrationContext } }
  >
}

/** A pane is a dispatched worker only while it carries an orchestration dispatch.
 *  A coordinator is nobody's dispatch target, so it never matches. */
export function isDispatchedOrchestrationWorkerPane(
  state: DispatchedWorkerPolicyState,
  paneKey: string | undefined
): boolean {
  if (!paneKey) {
    return false
  }
  const context =
    state.runtimeAgentOrchestrationByPaneKey?.[paneKey] ??
    state.agentStatusByPaneKey?.[paneKey]?.orchestration ??
    state.retainedAgentsByPaneKey?.[paneKey]?.entry?.orchestration
  return Boolean(context?.dispatchId)
}

/** Silences the OS banner and the phone push for a worker completion; unread
 *  markers are set by the caller before this gate, so nothing is lost in-app. */
export function shouldSuppressDispatchedWorkerNotification(
  state: DispatchedWorkerPolicyState,
  paneKey: string | undefined
): boolean {
  if (state.settings?.notifications?.dispatchedWorkerTaskComplete !== false) {
    return false
  }
  return isDispatchedOrchestrationWorkerPane(state, paneKey)
}
