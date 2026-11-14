import { copyBrowserPageHandles } from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusEvidenceObservedAt
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import { mainAgentStatusEqual } from '../../../../shared/agent-status/lifecycle/main-agent-status'
import { programStatusFacetsEqual } from '../../../../shared/program-status/facet'
import type {
  WebSessionTabsBatchContext,
  WebSessionTabsBatchRecordKey,
  WebSessionTabsSyncState
} from './state'

export function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((value, index) => value === b[index])
}

export function sameAgentStateHistory(
  a: AgentStatusEntry['stateHistory'],
  b: AgentStatusEntry['stateHistory']
): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every(
    (entry, index) =>
      entry.state === b[index]?.state &&
      entry.prompt === b[index]?.prompt &&
      entry.startedAt === b[index]?.startedAt &&
      entry.interrupted === b[index]?.interrupted &&
      mainAgentStatusEqual(entry.mainAgent, b[index]?.mainAgent)
  )
}

export function agentStatusEntryEqual(
  a: AgentStatusEntry | undefined,
  b: AgentStatusEntry
): boolean {
  if (!a) {
    return false
  }
  return (
    a.state === b.state &&
    a.workingMode === b.workingMode &&
    a.prompt === b.prompt &&
    a.updatedAt === b.updatedAt &&
    a.stateStartedAt === b.stateStartedAt &&
    a.turnStartedAt === b.turnStartedAt &&
    a.turnEndedAt === b.turnEndedAt &&
    a.turnEndDisposition === b.turnEndDisposition &&
    a.agentType === b.agentType &&
    a.paneKey === b.paneKey &&
    a.worktreeId === b.worktreeId &&
    a.tabId === b.tabId &&
    a.terminalTitle === b.terminalTitle &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.interactivePrompt === b.interactivePrompt &&
    a.lastAssistantMessage === b.lastAssistantMessage &&
    a.lastAssistantMessageIsToolOutput === b.lastAssistantMessageIsToolOutput &&
    a.interrupted === b.interrupted &&
    mainAgentStatusEqual(a.mainAgent, b.mainAgent) &&
    a.promptInteractionKey === b.promptInteractionKey &&
    a.restoredUnconfirmed === b.restoredUnconfirmed &&
    a.launchAttested === b.launchAttested &&
    programStatusFacetsEqual(a.programStatus, b.programStatus) &&
    agentProviderSessionsEqual(a.agentType, a.providerSession, b.providerSession) &&
    a.orcaSessionId === b.orcaSessionId &&
    sameAgentStateHistory(a.stateHistory, b.stateHistory)
  )
}

export function isAgentStatusFresh(
  entry: Pick<
    AgentStatusEntry,
    'updatedAt' | 'evidenceObservedAt' | 'mirroredEvidenceReceivedAt' | 'restoredUnconfirmed'
  >,
  now: number
): boolean {
  // Use shared reader-clock observation time like display gating; mirrored row stamps belong to host clocks.
  return (
    entry.restoredUnconfirmed !== true &&
    now - agentStatusEvidenceObservedAt(entry) <= AGENT_STATUS_STALE_AFTER_MS
  )
}

export function isMirroredCommandCodeTurnBump(
  existing: AgentStatusEntry | undefined,
  entry: AgentStatusEntry
): boolean {
  return (
    existing?.agentType === 'command-code' &&
    entry.agentType === 'command-code' &&
    existing.state === 'working' &&
    entry.state === 'working' &&
    entry.stateStartedAt > existing.stateStartedAt
  )
}

export function sanitizeRecentTabIds(recent: string[] | undefined, tabOrder: string[]): string[] {
  if (!recent || recent.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  const seen = new Set<string>()
  const reversed: string[] = []
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const id = recent[i]
    if (!valid.has(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    reversed.push(id)
  }
  return reversed.toReversed()
}

export function pushRecentTabId(recent: string[] | undefined, tabId: string): string[] {
  const base = recent ?? []
  if (base.length > 0 && base.at(-1) === tabId) {
    return base
  }
  return [...base.filter((id) => id !== tabId), tabId]
}

export function writableWebSessionTabsRecord<K extends WebSessionTabsBatchRecordKey>(
  state: WebSessionTabsSyncState,
  recordKey: K,
  batchContext?: WebSessionTabsBatchContext
): NonNullable<WebSessionTabsSyncState[K]> {
  const record = (state[recordKey] ?? {}) as NonNullable<WebSessionTabsSyncState[K]>
  if (!batchContext) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each branch copies the selected record without changing its value type; TypeScript cannot narrow generic K.
    return (
      recordKey === 'remoteBrowserPageHandlesByPageId'
        ? copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId)
        : { ...record }
    ) as NonNullable<WebSessionTabsSyncState[K]>
  }
  // Batch-owned record copies can be updated in place without recopying all workspaces.
  if (batchContext.changedRecords.has(recordKey)) {
    return record
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each branch copies the selected record without changing its value type; TypeScript cannot narrow generic K.
  const next = (
    recordKey === 'remoteBrowserPageHandlesByPageId'
      ? copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId)
      : { ...record }
  ) as NonNullable<WebSessionTabsSyncState[K]>
  const mutableState = state as unknown as Record<
    WebSessionTabsBatchRecordKey,
    Record<string, unknown>
  >
  mutableState[recordKey] = next as Record<string, unknown>
  batchContext.changedRecords.add(recordKey)
  return next
}

export function withWorktreeEntry<T>(
  state: WebSessionTabsSyncState,
  recordKey: WebSessionTabsBatchRecordKey,
  key: string,
  value: T | null,
  equal: (a: T | undefined, b: T | null) => boolean,
  batchContext?: WebSessionTabsBatchContext,
  deleteNull = true
): Record<string, T> {
  const record = (state[recordKey] ?? {}) as Record<string, T>
  if (equal(record[key], value)) {
    return record
  }
  const next = writableWebSessionTabsRecord(state, recordKey, batchContext) as Record<string, T>
  if (value === null && deleteNull) {
    delete next[key]
  } else {
    next[key] = value as T
  }
  return next
}
