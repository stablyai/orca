import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'

export function tabFromAttributedStatusEntry(entry: AgentStatusEntry): TerminalTab | null {
  const parsed = parsePaneKey(entry.paneKey)
  if (!parsed || !entry.worktreeId) {
    return null
  }
  return {
    id: parsed.tabId,
    ptyId: null,
    worktreeId: entry.worktreeId,
    title: entry.terminalTitle ?? 'Agent',
    customTitle: null,
    color: null,
    sortOrder: Number.MAX_SAFE_INTEGER,
    createdAt: entry.stateStartedAt
  }
}

export function tabFromSleepingAgentSession(record: SleepingAgentSessionRecord): TerminalTab {
  const parsed = parsePaneKey(record.paneKey)
  const tabId = record.tabId ?? parsed?.tabId ?? `sleeping-${record.paneKey}`
  return {
    id: tabId,
    ptyId: null,
    worktreeId: record.worktreeId,
    title: record.terminalTitle ?? record.agent,
    customTitle: null,
    color: null,
    sortOrder: Number.MAX_SAFE_INTEGER,
    createdAt: record.updatedAt
  }
}

export function sleepingRecordToAgentStatusEntry(
  record: SleepingAgentSessionRecord
): AgentStatusEntry {
  return {
    paneKey: record.paneKey,
    state: record.state,
    prompt: record.prompt,
    updatedAt: record.updatedAt,
    stateStartedAt: record.updatedAt,
    stateHistory: [],
    agentType: record.agent,
    worktreeId: record.worktreeId,
    ...(record.tabId ? { tabId: record.tabId } : {}),
    terminalTitle: record.terminalTitle,
    lastAssistantMessage: record.lastAssistantMessage,
    providerSession: record.providerSession,
    ...(record.promptInteractions ? { promptInteractions: record.promptInteractions } : {}),
    interrupted: false
  }
}
