import { useAppStore } from '@/store'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import {
  getProviderSessionClaimKey,
  isPassiveCompletedHibernationEvidence,
  recordPaneIsOwnedByPreservedPane
} from './sleeping-agent-pane-ownership'
import {
  launchSleepingAgentSession,
  type ResumeSleepingAgentSessionsOptions
} from './sleeping-agent-session-launch'

export type { ResumeSleepingAgentSessionsOptions } from './sleeping-agent-session-launch'

function clearPassiveCompletedRecordsForClaimKey(
  records: readonly SleepingAgentSessionRecord[],
  claimKey: string,
  keepPaneKey: string
): void {
  const state = useAppStore.getState()
  for (const record of records) {
    if (record.paneKey === keepPaneKey || !isPassiveCompletedHibernationEvidence(record)) {
      continue
    }
    if (getProviderSessionClaimKey(record) === claimKey) {
      state.clearSleepingAgentSession(record.paneKey)
    }
  }
}

function getCurrentPaneOwnedClaimKeys(records: readonly SleepingAgentSessionRecord[]): Set<string> {
  const state = useAppStore.getState()
  const keys = new Set<string>()
  for (const record of records) {
    if (
      state.sleepingAgentSessionsByPaneKey[record.paneKey] !== record ||
      isInvalidWorktreeActivationRecord(record) ||
      isPassiveCompletedHibernationEvidence(record)
    ) {
      continue
    }
    if (recordPaneIsOwnedByPreservedPane(record, state)) {
      keys.add(getProviderSessionClaimKey(record))
    }
  }
  return keys
}

function getNewestActiveRecordsByClaimKey(
  records: readonly SleepingAgentSessionRecord[]
): Map<string, SleepingAgentSessionRecord> {
  const newestRecords = new Map<string, SleepingAgentSessionRecord>()
  for (const record of records) {
    const claimKey = getProviderSessionClaimKey(record)
    const current = newestRecords.get(claimKey)
    if (
      !current ||
      record.capturedAt > current.capturedAt ||
      (record.capturedAt === current.capturedAt && record.updatedAt > current.updatedAt)
    ) {
      newestRecords.set(claimKey, record)
    }
  }
  return newestRecords
}

function getAgentStatusTabId(entry: {
  paneKey: string
  tabId?: string | undefined
}): string | null {
  if (entry.tabId) {
    return entry.tabId
  }
  const separatorIndex = entry.paneKey.indexOf(':')
  return separatorIndex === -1 ? null : entry.paneKey.slice(0, separatorIndex)
}

function activeOrQueuedResumeClaimsProviderSession(
  record: SleepingAgentSessionRecord,
  state: ReturnType<typeof useAppStore.getState>
): boolean {
  const worktreeTabIds = new Set(
    (state.tabsByWorktree[record.worktreeId] ?? []).map((tab) => tab.id)
  )
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (
      worktreeTabIds.has(getAgentStatusTabId(entry) ?? '') &&
      entry.worktreeId === record.worktreeId &&
      entry.agentType === record.agent &&
      entry.state !== 'done' &&
      agentProviderSessionsEqual(record.agent, entry.providerSession, record.providerSession)
    ) {
      return true
    }
  }

  for (const [tabId, startup] of Object.entries(state.pendingStartupByTabId)) {
    if (
      worktreeTabIds.has(tabId) &&
      startup.launchAgent === record.agent &&
      agentProviderSessionsEqual(
        record.agent,
        startup.resumeProviderSession,
        record.providerSession
      )
    ) {
      return true
    }
  }

  for (const [tabId, claim] of Object.entries(state.automaticAgentResumeClaimsByTabId)) {
    if (
      worktreeTabIds.has(tabId) &&
      claim.worktreeId === record.worktreeId &&
      claim.launchAgent === record.agent &&
      agentProviderSessionsEqual(record.agent, claim.providerSession, record.providerSession)
    ) {
      return true
    }
  }
  return false
}

function isInvalidWorktreeActivationRecord(record: SleepingAgentSessionRecord): boolean {
  if (record.interrupted === true) {
    return true
  }
  if (!record.origin && record.state === 'done') {
    return true
  }
  return (
    record.state !== 'done' && record.capturedAt - record.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  )
}

export function resumeSleepingAgentSessionsForWorktree(
  worktreeId: string,
  options?: ResumeSleepingAgentSessionsOptions
): number {
  const state = useAppStore.getState()
  const worktreeRecords = Object.values(state.sleepingAgentSessionsByPaneKey)
    .filter((record) => record.worktreeId === worktreeId)
    .sort((a, b) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)
  const validWorktreeRecords = worktreeRecords.filter(
    (record) => !isInvalidWorktreeActivationRecord(record)
  )
  const activeWorktreeRecords = validWorktreeRecords.filter(
    (record) => !isPassiveCompletedHibernationEvidence(record)
  )
  const activeClaimKeys = new Set(activeWorktreeRecords.map(getProviderSessionClaimKey))
  const newestActiveRecordByClaimKey = getNewestActiveRecordsByClaimKey(activeWorktreeRecords)
  const freshlyLaunchedClaimKeys = new Set<string>()

  let launched = 0
  for (const record of worktreeRecords) {
    const currentState = useAppStore.getState()
    if (currentState.sleepingAgentSessionsByPaneKey[record.paneKey] !== record) {
      continue
    }
    const claimKey = getProviderSessionClaimKey(record)
    // Why: a mounted pane already consumed (or latched) the in-place
    // hibernation wake for this session; its record clears when that spawn
    // succeeds. Launching or clearing here would double-resume the session.
    if (options?.skipClaimKeys?.has(claimKey)) {
      continue
    }
    if (isInvalidWorktreeActivationRecord(record)) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    const isPaneOwned = recordPaneIsOwnedByPreservedPane(record, currentState)
    if (isPassiveCompletedHibernationEvidence(record)) {
      // Why: completed-agent hibernation is passive history; activation should
      // only keep displayable evidence, never start new work from it.
      if (!isPaneOwned || activeClaimKeys.has(claimKey)) {
        state.clearSleepingAgentSession(record.paneKey)
      }
      continue
    }
    if (activeOrQueuedResumeClaimsProviderSession(record, currentState)) {
      // Why: main can replay the old wake record after the same provider
      // session was already queued in a fresh tab; clear the stale replay.
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    const paneOwnedClaimKeys = getCurrentPaneOwnedClaimKeys(activeWorktreeRecords)
    if (paneOwnedClaimKeys.has(claimKey)) {
      if (!isPaneOwned) {
        state.clearSleepingAgentSession(record.paneKey)
      }
      continue
    }
    if (freshlyLaunchedClaimKeys.has(claimKey)) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    if (newestActiveRecordByClaimKey.get(claimKey) !== record) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    if (isPaneOwned) {
      continue
    }
    if (launchSleepingAgentSession(record, options)) {
      launched += 1
      freshlyLaunchedClaimKeys.add(claimKey)
      clearPassiveCompletedRecordsForClaimKey(worktreeRecords, claimKey, record.paneKey)
    }
  }
  return launched
}
