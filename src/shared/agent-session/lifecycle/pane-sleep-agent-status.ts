import { paneAgentCompletion } from './pane-agent-completion'
import type { AgentStatusEntry } from '../../agent-status/contracts/agent-status-types'
import {
  isDisplayOnlyPaneSleep,
  isPaneSleepRecord,
  type DisplayOnlyPaneSleep,
  type OwnedPaneAgentRecord
} from './agent-session-resume'

const rows = new WeakMap<OwnedPaneAgentRecord, AgentStatusEntry & { turnCompletedAt?: number }>()

/** A deliberately slept pane owns its display; projecting it never completes a turn. */
export function paneSleepAgentStatus(
  record: OwnedPaneAgentRecord
): (AgentStatusEntry & { turnCompletedAt?: number }) | null {
  if (!isPaneSleepRecord(record)) {
    return null
  }
  const cached = rows.get(record)
  if (cached) {
    return cached
  }
  const display = isDisplayOnlyPaneSleep(record)
    ? record.display
    : { ...record, agentType: record.agent }
  const row: AgentStatusEntry & { turnCompletedAt?: number } = {
    paneKey: record.paneKey,
    tabId: record.tabId,
    worktreeId: record.worktreeId,
    connectionId: record.connectionId,
    state: 'done',
    ...(record.completion?.kind === 'current' && record.completion.turnCompletedAt !== undefined
      ? { turnCompletedAt: record.completion.turnCompletedAt }
      : {}),
    ...(record.completion?.kind === 'current' ? {} : { sessionBoundary: true }),
    prompt: display.prompt,
    agentType: display.agentType,
    providerSession: display.providerSession,
    updatedAt: display.updatedAt,
    stateStartedAt: display.stateStartedAt ?? display.updatedAt,
    firstStateStartedAt: display.firstStateStartedAt,
    turnStartedAt: display.turnStartedAt,
    turnEndedAt: display.turnEndedAt,
    turnEndDisposition: display.turnEndDisposition,
    terminalTitle: display.terminalTitle,
    lastAssistantMessage: display.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: display.lastAssistantMessageIsToolOutput,
    interrupted: display.interrupted,
    mainAgent: display.mainAgent,
    ...(isDisplayOnlyPaneSleep(record) ? { terminalResumeEligible: false as const } : {}),
    stateHistory: record.completion?.kind === 'previous' ? [record.completion.end] : [],
    ...(record.completion?.kind === 'previous'
      ? { lastCompletedAssistantMessage: record.completion.lastAssistantMessage }
      : {})
  }
  rows.set(record, row)
  return row
}

export function displayOnlyPaneSleepFromEntry(
  entry: AgentStatusEntry,
  worktreeId: string,
  capturedAt: number,
  tabId?: string
): DisplayOnlyPaneSleep {
  return {
    kind: 'display-only',
    completion: paneAgentCompletion(entry),
    paneKey: entry.paneKey,
    tabId: tabId ?? entry.tabId,
    worktreeId,
    origin: 'worktree-sleep',
    capturedAt,
    connectionId: entry.connectionId,
    display: {
      state: 'done',
      agentType: entry.agentType,
      providerSession: entry.providerSession,
      prompt: entry.prompt,
      updatedAt: entry.updatedAt,
      stateStartedAt: entry.stateStartedAt,
      firstStateStartedAt: entry.firstStateStartedAt,
      turnStartedAt: entry.turnStartedAt,
      turnEndedAt: entry.turnEndedAt,
      turnEndDisposition: entry.turnEndDisposition,
      terminalTitle: entry.terminalTitle,
      lastAssistantMessage: entry.lastAssistantMessage,
      lastAssistantMessageIsToolOutput: entry.lastAssistantMessageIsToolOutput,
      interrupted: entry.interrupted,
      mainAgent: entry.mainAgent
    }
  }
}
