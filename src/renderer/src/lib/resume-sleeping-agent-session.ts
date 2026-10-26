import { useAppStore } from '@/store'
import { isWorkspaceSleepRecord } from '../../../shared/workspace-sleep'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  getProviderSessionClaimKey,
  activationTreatsNoteAsFinished,
  recordPaneIsOwnedByPreservedPane,
  stablePaneHasLivePty
} from './sleeping-agent-pane-ownership'
import { isPaneSpawnDeferred } from './pane-spawn-deferral-registry'
import {
  launchSleepingAgentSession,
  type ResumeSleepingAgentSessionsOptions
} from './sleeping-agent-session-launch'
import { isStructuredAgentSyntheticSleepingRecord } from './structured-agent-synthetic-sleeping-record'
import {
  findUnhydratedHostMirrorForPane,
  isHostMirroredSleepingRecord,
  type UnhydratedHostMirror
} from './host-mirrored-pane-liveness'
import { parkUntilHostMirrorHandleLands } from './host-mirror-handle-gap-wait'
import { getClaimRepresentativeRecords } from './sleeping-record-claim-representative'
import {
  sleepingRecordHostAllowsSessionClaim,
  sleepingRecordNamesAnotherExecutionHost
} from './sleeping-record-execution-host-scope'
import { resolveWorkspaceTerminalHostAuthority } from './workspace-terminal-host-authority'
import { parkUntilHostSessionMirrorHydrates } from '@/runtime/host-session-mirror-hydration'

export type { ResumeSleepingAgentSessionsOptions } from './sleeping-agent-session-launch'

function clearPassiveCompletedRecordsForClaimKey(
  records: readonly SleepingAgentSessionRecord[],
  claimKey: string,
  keepPaneKey: string
): void {
  const state = useAppStore.getState()
  for (const record of records) {
    if (record.paneKey === keepPaneKey || !activationTreatsNoteAsFinished(record)) {
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
      activationTreatsNoteAsFinished(record)
    ) {
      continue
    }
    if (recordPaneIsOwnedByPreservedPane(record, state)) {
      keys.add(getProviderSessionClaimKey(record))
    }
  }
  return keys
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
    const tabId = getAgentStatusTabId(entry)
    const pane = parsePaneKey(entry.paneKey)
    if (
      entry.agentType !== record.agent ||
      !agentProviderSessionsEqual(record.agent, entry.providerSession, record.providerSession)
    ) {
      continue
    }
    // Live PTYs own provider transcripts across workspace IDs, including after orphan adoption rekeys tabs but not records. Ignore turn state: done can mean a live REPL, so clear queued respawn rather than fork. Pane/shell/transcript survive and manual resume remains possible; the scoped nonlive arm still treats status as historical evidence.
    if (
      pane &&
      tabId === pane.tabId &&
      stablePaneHasLivePty(
        pane.tabId,
        pane.leafId,
        state.ptyIdsByTabId,
        state.terminalLayoutsByTabId[pane.tabId]
      )
    ) {
      return true
    }
    if (
      entry.state !== 'done' &&
      worktreeTabIds.has(tabId ?? '') &&
      entry.worktreeId === record.worktreeId
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

function providerSessionOwnedElsewhere(
  record: SleepingAgentSessionRecord,
  state: ReturnType<typeof useAppStore.getState>
): boolean {
  // Claim keys handle same-workspace duplicates; finished notes, moved hosts and foreign-machine records cannot claim sessions.
  return Object.values(state.sleepingAgentSessionsByPaneKey).some(
    (other) =>
      other.worktreeId !== record.worktreeId &&
      other.agent === record.agent &&
      !isInvalidWorktreeActivationRecord(other) &&
      !activationTreatsNoteAsFinished(other) &&
      sleepingRecordHostAllowsSessionClaim(other, record, state) &&
      agentProviderSessionsEqual(record.agent, other.providerSession, record.providerSession) &&
      recordPaneIsOwnedByPreservedPane(other, state)
  )
}

// Interrupted turns remain resumable at the prompt; discarding their records strands wake/restart recovery.
function isInvalidWorktreeActivationRecord(record: SleepingAgentSessionRecord): boolean {
  if (isStructuredAgentSyntheticSleepingRecord(record)) {
    return true
  }
  if (!record.origin && record.state === 'done') {
    return true
  }
  return (
    record.state !== 'done' && record.capturedAt - record.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  )
}

function replayParkedWorktreeResumeSweep(
  worktreeId: string,
  options: ResumeSleepingAgentSessionsOptions | undefined
): void {
  // Mirror verdicts can settle after navigation; replayed resumes must not steal the current surface.
  const isActive = useAppStore.getState().activeWorktreeId === worktreeId
  // Drop park-time skipClaimKeys; an in-place wake that failed since parking must remain resumable.
  resumeSleepingAgentSessionsForWorktree(worktreeId, {
    ...(options?.onSessionLaunched ? { onSessionLaunched: options.onSessionLaunched } : {}),
    ...(isActive ? {} : { suppressNavigation: true })
  })
}

function parkWorktreeResumeSweepUntilHostMirrorAnswers(
  worktreeId: string,
  mirror: UnhydratedHostMirror,
  options: ResumeSleepingAgentSessionsOptions | undefined
): void {
  const replay = (): void => replayParkedWorktreeResumeSweep(worktreeId, options)
  if (mirror.kind === 'handle') {
    parkUntilHostMirrorHandleLands(mirror.environmentId, worktreeId, mirror.tabId, replay)
    return
  }
  if (!mirror.environmentId) {
    // No paired runtime owns the workspace, so no verdict is coming; the next
    // activation re-runs this sweep once one does.
    return
  }
  parkUntilHostSessionMirrorHydrates(mirror.environmentId, worktreeId, replay)
}

export function resumeSleepingAgentSessionsForWorktree(
  worktreeId: string,
  options?: ResumeSleepingAgentSessionsOptions
): number {
  const state = useAppStore.getState()
  // Before the execution host answers, absent local panes are unverifiable, not exited; resume could fork a live transcript (STA-3500). Retain records for the later sweep; paired runtimes also have finer per-pane mirror parking.
  const hostAuthority = resolveWorkspaceTerminalHostAuthority(state, worktreeId)
  if (hostAuthority === 'unverifiable') {
    return 0
  }
  // Main owns workspace-sleep resumes in their original panes; this sweep must not create fresh tabs.
  const worktreeRecords = Object.values(state.sleepingAgentSessionsByPaneKey)
    .filter((record) => record.worktreeId === worktreeId && !isWorkspaceSleepRecord(record))
    .sort((a, b) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)
  const validWorktreeRecords = worktreeRecords.filter(
    (record) => !isInvalidWorktreeActivationRecord(record)
  )
  const activeWorktreeRecords = validWorktreeRecords.filter(
    (record) => !activationTreatsNoteAsFinished(record)
  )
  const activeClaimKeys = new Set(activeWorktreeRecords.map(getProviderSessionClaimKey))
  // Why: a record this host may not resume must not outrank, and so delete, one it may.
  const claimRepresentativeByKey = getClaimRepresentativeRecords(
    activeWorktreeRecords.filter(
      (record) => !sleepingRecordNamesAnotherExecutionHost(record, state)
    )
  )
  const freshlyLaunchedClaimKeys = new Set<string>()

  let launched = 0
  for (const record of worktreeRecords) {
    const currentState = useAppStore.getState()
    if (currentState.sleepingAgentSessionsByPaneKey[record.paneKey] !== record) {
      continue
    }
    const claimKey = getProviderSessionClaimKey(record)
    // An in-place hibernation wake owns its record until spawn succeeds; launching or clearing here would duplicate resume.
    if (options?.skipClaimKeys?.has(claimKey)) {
      continue
    }
    // Host-deferred panes own queued startup without PTYs; retain their records for opening instead of clearing as duplicates.
    if (isPaneSpawnDeferred(record.paneKey)) {
      continue
    }
    if (isInvalidWorktreeActivationRecord(record)) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    // Host disagreement does not invalidate this machine-scoped locator. Retain it for manual retry; deleting loses the transcript handle, while wrong-host resume can fail or fork.
    if (sleepingRecordNamesAnotherExecutionHost(record, currentState)) {
      continue
    }
    const unhydratedMirror = findUnhydratedHostMirrorForPane(record, currentState)
    if (unhydratedMirror) {
      // Launch and clear both require mirror evidence; do neither until replay reruns with an authoritative verdict.
      parkWorktreeResumeSweepUntilHostMirrorAnswers(worktreeId, unhydratedMirror, options)
      continue
    }
    const isPaneOwned = recordPaneIsOwnedByPreservedPane(record, currentState)
    if (activationTreatsNoteAsFinished(record)) {
      // Completed hibernated agents are passive history; activation preserves display evidence without starting work.
      if (!isPaneOwned || activeClaimKeys.has(claimKey)) {
        state.clearSleepingAgentSession(record.paneKey)
      }
      continue
    }
    if (activeOrQueuedResumeClaimsProviderSession(record, currentState, isPaneOwned)) {
      // Clear stale main wake replays once this provider session is already queued in a fresh tab.
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
    if (claimRepresentativeByKey.get(claimKey) !== record) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    if (isPaneOwned) {
      continue
    }
    // Paired-runtime local rows cannot prove another client’s close versus rekey/pending handle (#21235); only the host authorizes writers. Mirror records represent their claim keys, suppressing native siblings.
    if (hostAuthority === 'live' || isHostMirroredSleepingRecord(record)) {
      continue
    }
    // Provider sessions span workspaces; stale record IDs must not relaunch a transcript owned by another record’s pane.
    if (providerSessionOwnedElsewhere(record, currentState)) {
      state.clearSleepingAgentSession(record.paneKey)
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
