import type { Tab } from '../../workspace-layout/tab-groups/tab-types'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../contracts/agent-status-types'
import { isWebTerminalSurfaceTabId } from '../../workspace-layout/terminal-surface-id'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../workspace-layout/stable-pane-id'
import {
  chatPaneAddressTabId,
  chatPaneKey,
  chatPaneKeySessionId
} from '../../agent-session/view/structured-agent-session-projection'

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
    chatPaneKey(representedTab.entityId) === paneKey
  ) {
    return {
      tabId: representedTab.id,
      paneId: paneKey.slice(chatPaneAddressTabId(representedTab.entityId).length + 1)
    }
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
  // Host-reported workspace ownership survives colliding mirrored tab IDs; a chat's key names its
  // conversation, which another workspace's tab id can equal, so its own row's workspace wins.
  if (
    entry.worktreeId &&
    (entry.connectionId ||
      isWebTerminalSurfaceTabId(paneIdentity?.tabId ?? '') ||
      chatPaneKeySessionId(entry.paneKey) !== null)
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
