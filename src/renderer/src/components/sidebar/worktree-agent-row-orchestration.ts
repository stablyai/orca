import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'

function orchestrationContextsEqual(
  a: AgentStatusOrchestrationContext,
  b: AgentStatusOrchestrationContext
): boolean {
  return (
    a.taskId === b.taskId &&
    a.dispatchId === b.dispatchId &&
    a.taskTitle === b.taskTitle &&
    a.displayName === b.displayName &&
    a.parentTerminalHandle === b.parentTerminalHandle &&
    a.parentPaneKey === b.parentPaneKey &&
    a.coordinatorHandle === b.coordinatorHandle &&
    a.orchestrationRunId === b.orchestrationRunId
  )
}

export function entryWithRuntimeOrchestration(
  entry: AgentStatusEntry,
  runtimeAgentOrchestrationByPaneKey: Record<string, AgentStatusOrchestrationContext> | undefined
): AgentStatusEntry {
  const runtimeOrchestration = runtimeAgentOrchestrationByPaneKey?.[entry.paneKey]
  const sameDispatch =
    entry.orchestration &&
    runtimeOrchestration &&
    entry.orchestration.taskId === runtimeOrchestration.taskId &&
    entry.orchestration.dispatchId === runtimeOrchestration.dispatchId
  if (entry.orchestration && runtimeOrchestration && !sameDispatch) {
    return entry
  }
  const orchestration =
    sameDispatch && entry.orchestration && runtimeOrchestration
      ? { ...entry.orchestration, ...runtimeOrchestration }
      : (runtimeOrchestration ?? entry.orchestration)
  if (!orchestration || orchestration === entry.orchestration) {
    return entry
  }
  if (entry.orchestration && orchestrationContextsEqual(entry.orchestration, orchestration)) {
    return entry
  }
  // Reuse metadata only within the same dispatch so recycled terminals cannot inherit stale parents.
  return { ...entry, orchestration }
}
