import type { PaneAgentCompletion } from './pane-agent-completion'
import type { AgentStatusEntry } from '../../agent-status/contracts/agent-status-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentSessionRecord
} from './agent-session-resume'

export type PaneAgentDisplay = Pick<
  AgentStatusEntry,
  | 'agentType'
  | 'providerSession'
  | 'prompt'
  | 'updatedAt'
  | 'stateStartedAt'
  | 'firstStateStartedAt'
  | 'turnStartedAt'
  | 'turnEndedAt'
  | 'turnEndDisposition'
  | 'terminalTitle'
  | 'lastAssistantMessage'
  | 'lastAssistantMessageIsToolOutput'
  | 'interrupted'
  | 'mainAgent'
> & { state: 'done' }

export type DisplayOnlyPaneSleep = {
  kind: 'display-only'
  completion?: PaneAgentCompletion
  paneKey: string
  tabId?: string
  worktreeId: string
  origin: 'worktree-sleep'
  capturedAt: number
  connectionId?: string | null
  display: PaneAgentDisplay
}

export type OwnedPaneAgentRecord = SleepingAgentSessionRecord | DisplayOnlyPaneSleep

export function paneAgentRecordIdentity(record: OwnedPaneAgentRecord | undefined): {
  agent?: AgentStatusEntry['agentType']
  providerSession?: AgentProviderSessionMetadata
} {
  return !record
    ? {}
    : isDisplayOnlyPaneSleep(record)
      ? { agent: record.display.agentType, providerSession: record.display.providerSession }
      : record
}

export function resumablePaneRecord(
  record: OwnedPaneAgentRecord | undefined
): SleepingAgentSessionRecord | undefined {
  return record && isResumablePaneRecord(record) ? record : undefined
}

export function isDisplayOnlyPaneSleep(record: { kind?: unknown }): record is DisplayOnlyPaneSleep {
  return record.kind === 'display-only'
}

export function isResumablePaneRecord<T extends { kind?: unknown }>(
  record: T
): record is T & SleepingAgentSessionRecord {
  return record.kind === undefined
}
/** A record of a slept pane (worktree sleep, or a legacy record); 'quit'/'live' resume a running agent. */
export function isPaneSleepRecord(record: Pick<OwnedPaneAgentRecord, 'origin'>): boolean {
  return record.origin === undefined || record.origin === 'worktree-sleep'
}

/** Tagged deliberate captures are written by exact owner intents, never bulk window saves. */
export function isExplicitPaneSleepRecord(record: Pick<OwnedPaneAgentRecord, 'origin'>): boolean {
  return record.origin === 'worktree-sleep'
}

/** Only host-wake sleep records count: live/quit panes restore themselves, and tab-open-only panes wait for their tab. */
export function hasSleptAgentToWake(
  records: Record<string, OwnedPaneAgentRecord> | undefined,
  worktreeId: string
): boolean {
  return Object.values(records ?? {}).some(
    (record) =>
      isResumablePaneRecord(record) &&
      record.worktreeId === worktreeId &&
      isPaneSleepRecord(record) &&
      record.restoreOnTabOpenOnly !== true
  )
}
