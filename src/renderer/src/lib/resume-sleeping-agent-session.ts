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
import { findUnhydratedHostMirrorForPane } from './host-mirrored-pane-liveness'
import { parkUntilHostSessionMirrorHydrates } from '@/runtime/host-session-mirror-hydration'

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

/**
 * Absolute age after which an unfinished resume record stops being a resume candidate.
 *
 * Why this exists on top of the staleness check below: that check compares two timestamps
 * captured together, so it measures how long the agent had been silent *at capture time* and
 * never how long the record has since been sitting there. A live capture writes `capturedAt`
 * from the same value as `updatedAt`, which makes the difference ~0 no matter how old the
 * record gets. Without an absolute bound, any agent that ends without a confirmable exit
 * transition — SIGKILL, force quit, host reboot, a status hook that never fires — leaves a
 * record that stays a valid resume candidate forever.
 *
 * Why a week: the surrounding intent is deliberately permissive about resuming interrupted
 * turns, and the cost of expiring too early is small — the transcript survives and the session
 * can still be resumed by hand — while the cost of never expiring is an unattended relaunch.
 */
export const RESUME_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Why: an interrupted turn is still resumable — `claude --resume` reopens the transcript at the
// prompt — so discarding those records only stranded the session across wake and restart.
function isInvalidWorktreeActivationRecord(record: SleepingAgentSessionRecord): boolean {
  if (!record.origin && record.state === 'done') {
    return true
  }
  if (record.state === 'done') {
    return false
  }
  if (record.capturedAt - record.updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
    return true
  }
  return Date.now() - record.capturedAt > RESUME_RECORD_MAX_AGE_MS
}

function parkWorktreeResumeSweepUntilHostMirrorHydrates(
  worktreeId: string,
  environmentId: string | null,
  options: ResumeSleepingAgentSessionsOptions | undefined
): void {
  if (!environmentId) {
    // No paired runtime owns the workspace, so no verdict is coming; the next
    // activation re-runs this sweep once one does.
    return
  }
  parkUntilHostSessionMirrorHydrates(environmentId, worktreeId, () => {
    // Why: the mirror can settle long after the user moved on, so a replayed
    // resume must not steal the surface they are looking at now.
    const isActive = useAppStore.getState().activeWorktreeId === worktreeId
    // Why `skipClaimKeys` is dropped: it is a park-time snapshot of in-place
    // wakes, and a latch that has since failed must stay resumable here.
    resumeSleepingAgentSessionsForWorktree(worktreeId, {
      ...(options?.onSessionLaunched ? { onSessionLaunched: options.onSessionLaunched } : {}),
      ...(isActive ? {} : { suppressNavigation: true })
    })
  })
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
    const unhydratedMirror = findUnhydratedHostMirrorForPane(record, currentState)
    if (unhydratedMirror) {
      // Why: pane ownership is undecidable until the mirror answers, and every
      // branch below — launch and clear alike — trusts that verdict. Take no
      // action on the record; the replay re-runs this pass with real evidence.
      parkWorktreeResumeSweepUntilHostMirrorHydrates(
        worktreeId,
        unhydratedMirror.environmentId,
        options
      )
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
    if (launchSleepingAgentSession(record, options)) {
      launched += 1
      freshlyLaunchedClaimKeys.add(claimKey)
      clearPassiveCompletedRecordsForClaimKey(worktreeRecords, claimKey, record.paneKey)
    }
  }
  return launched
}
