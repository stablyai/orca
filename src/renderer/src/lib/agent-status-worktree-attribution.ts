import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../shared/agent-status-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'

export type AgentStatusPaneIdentity = { tabId: string; paneId: string }

export function parseAgentStatusPaneIdentity(
  paneKey: string | undefined
): AgentStatusPaneIdentity | null {
  if (!paneKey) {
    return null
  }
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    return { tabId: parsed.tabId, paneId: parsed.leafId }
  }
  const legacy = parseLegacyNumericPaneKey(paneKey)
  return legacy ? { tabId: legacy.tabId, paneId: legacy.numericPaneId } : null
}

export function resolveAgentStatusWorktreeId(
  entry: Pick<AgentStatusEntry, 'paneKey' | 'worktreeId' | 'orchestration'>,
  worktreeIdByTabId: ReadonlyMap<string, string>,
  orchestration = entry.orchestration
): string | null {
  const paneIdentity = parseAgentStatusPaneIdentity(entry.paneKey)
  const parentIdentity = parseAgentStatusPaneIdentity(orchestration?.parentPaneKey)
  return (
    worktreeIdByTabId.get(paneIdentity?.tabId ?? '') ??
    entry.worktreeId ??
    worktreeIdByTabId.get(parentIdentity?.tabId ?? '') ??
    null
  )
}

export function mergeAgentStatusOrchestration(
  entry: Pick<AgentStatusEntry, 'orchestration'>,
  runtimeOrchestration: AgentStatusOrchestrationContext | undefined
): AgentStatusOrchestrationContext | undefined {
  if (!entry.orchestration) {
    return runtimeOrchestration
  }
  if (
    !runtimeOrchestration ||
    entry.orchestration.taskId !== runtimeOrchestration.taskId ||
    entry.orchestration.dispatchId !== runtimeOrchestration.dispatchId
  ) {
    return entry.orchestration
  }
  return { ...entry.orchestration, ...runtimeOrchestration }
}
