import type { Tab } from './tab-types'
import { structuredAgentSessionPaneKey } from './structured-agent-session-projection'
import type { AgentStatusEntry, AgentStatusOrchestrationContext } from './agent-status-types'
import { isWebTerminalSurfaceTabId } from './terminal-surface-id'
import { parseLegacyNumericPaneKey, parsePaneKey } from './stable-pane-id'

export type AgentStatusPaneIdentity = { tabId: string; paneId: string }

export function parseAgentStatusPaneIdentity(
  paneKey: string | undefined,
  representedTab?: Pick<Tab, 'id' | 'entityId' | 'contentType'>
): AgentStatusPaneIdentity | null {
  if (!paneKey) {
    return null
  }
  if (
    representedTab?.contentType === 'agent-session' &&
    structuredAgentSessionPaneKey(representedTab.id, representedTab.entityId) === paneKey
  ) {
    return { tabId: representedTab.id, paneId: paneKey.slice(representedTab.id.length + 1) }
  }
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    return { tabId: parsed.tabId, paneId: parsed.leafId }
  }
  const legacy = parseLegacyNumericPaneKey(paneKey)
  return legacy ? { tabId: legacy.tabId, paneId: legacy.numericPaneId } : null
}

export function resolveAgentStatusWorktreeId(
  entry: Pick<AgentStatusEntry, 'paneKey' | 'worktreeId' | 'orchestration' | 'connectionId'>,
  worktreeIdByTabId: Pick<ReadonlyMap<string, string>, 'get'>,
  orchestration = entry.orchestration
): string | null {
  const paneIdentity = parseAgentStatusPaneIdentity(entry.paneKey)
  // Host-reported workspace ownership survives colliding mirrored tab IDs.
  if (
    entry.worktreeId &&
    (entry.connectionId || isWebTerminalSurfaceTabId(paneIdentity?.tabId ?? ''))
  ) {
    return entry.worktreeId
  }
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
