import { useAppStore } from '@/store'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isDirectSshRemoteWorkspaceApplyInProgress } from '../hooks/remote-workspace-snapshot-apply'
import { getConnectionIdFromState } from './connection-owner-resolution'
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
  state: ReturnType<typeof useAppStore.getState>,
  samePaneOwnsRecovery: boolean
): boolean {
  const worktreeTabIds = new Set(
    (state.tabsByWorktree[record.worktreeId] ?? []).map((tab) => tab.id)
  )
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    // Why: only an owned pane needs its record; hidden/live panes still dedupe by status.
    if (samePaneOwnsRecovery && entry.paneKey === record.paneKey) {
      continue
    }
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

// Why: an interrupted turn is still resumable — `claude --resume` reopens the transcript at the
// prompt — so discarding those records only stranded the session across wake and restart.
function isInvalidWorktreeActivationRecord(record: SleepingAgentSessionRecord): boolean {
  if (!record.origin && record.state === 'done') {
    return true
  }
  return (
    record.state !== 'done' && record.capturedAt - record.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  )
}

function tabExistsInAnyWorktree(
  state: { tabsByWorktree: Record<string, readonly { id: string }[]> },
  tabId: string
): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) =>
    (tabs ?? []).some((tab) => tab.id === tabId)
  )
}

function tabExistsInPartition(
  partition: WorkspaceSessionState | null | undefined,
  tabId: string
): boolean {
  return Object.values(partition?.tabsByWorktree ?? {}).some((tabs) =>
    (tabs ?? []).some((tab) => tab?.id === tabId)
  )
}

const pendingStrandedRescueClaimKeys = new Set<string>()

function queueStrandedSleepingAgentRescue(
  record: SleepingAgentSessionRecord,
  wakeTabId: string,
  claimKey: string,
  options?: ResumeSleepingAgentSessionsOptions
): void {
  if (pendingStrandedRescueClaimKeys.has(claimKey)) {
    return
  }
  pendingStrandedRescueClaimKeys.add(claimKey)
  useAppStore.getState().beginStrandedSleepingAgentRescue(record.worktreeId)
  void (async () => {
    try {
      // Why: a snapshot apply suppresses session writes for its whole window,
      // so the partitions can lag the store mid-apply; and before the target
      // hydrates, the tab legitimately is not anywhere yet. Both are "cannot
      // prove the tab is gone" — keep the record and let a later sweep retry.
      if (isDirectSshRemoteWorkspaceApplyInProgress()) {
        return
      }
      const state = useAppStore.getState()
      const connectionId = getConnectionIdFromState(state, record.worktreeId)
      if (connectionId && !state.remoteWorkspaceHydratedTargetIds.has(connectionId)) {
        return
      }
      const partitions: WorkspaceSessionState[] = []
      try {
        partitions.push(await window.api.session.get())
        if (connectionId) {
          partitions.push(await window.api.session.get(toSshExecutionHostId(connectionId)))
        }
      } catch {
        // Why: an unreadable partition cannot prove the tab is gone; resuming
        // on failure is the duplicate-session direction.
        return
      }
      if (partitions.some((partition) => tabExistsInPartition(partition, wakeTabId))) {
        return
      }
      const fresh = useAppStore.getState()
      if (fresh.sleepingAgentSessionsByPaneKey[record.paneKey] !== record) {
        return
      }
      if (record.providerSession) {
        const ownedElsewhere = Object.values(fresh.sleepingAgentSessionsByPaneKey).some(
          (other) =>
            other !== record &&
            agentProviderSessionsEqual(
              record.agent,
              other.providerSession,
              record.providerSession
            ) &&
            recordPaneIsOwnedByPreservedPane(other, fresh)
        )
        if (ownedElsewhere) {
          fresh.clearSleepingAgentSession(record.paneKey)
          return
        }
      }
      launchSleepingAgentSession(record, options)
    } finally {
      pendingStrandedRescueClaimKeys.delete(claimKey)
      useAppStore.getState().endStrandedSleepingAgentRescue(record.worktreeId)
    }
  })()
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
    if (record.automaticResumeBlockedBy === 'legacy-orchestration-worker') {
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
    if (activeOrQueuedResumeClaimsProviderSession(record, currentState, isPaneOwned)) {
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
    const wakeTabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId
    if (wakeTabId && !tabExistsInAnyWorktree(currentState, wakeTabId)) {
      // Why: tabsByWorktree holds only materialized worktrees — absence here
      // cannot prove the session's tab is gone; resuming anyway forks the session.
      queueStrandedSleepingAgentRescue(record, wakeTabId, claimKey, options)
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
