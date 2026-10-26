import type { AppState } from '../../types'
import '../../../../../shared/agent-session-resume'
import { getAgentResumeArgv } from '../../../../../shared/agent-resume-argv'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import type { RetainedAgentEntry } from './agent-status-contract'
import {
  normalizePaneKeySet,
  paneKeyMatchesAnyTabPrefix,
  retainedAgentEntryFromLive
} from '../agent-status-pane-key-tab-binding'
import {
  isValidCompletedAgentHibernationEntry,
  manualSleepCaptureEntry,
  markManualSleepLazyRestore,
  normalizeSleepingAgentSessionCollectOptions,
  sleepingRecordFromEntry,
  type CollectSleepingAgentSessionRecordsOptions
} from './agent-status-sleeping-records'
import { getLaunchConfigForEntry } from '../agent-status-launch-config'
import { agentTurnEndedOnPurpose } from '../../../../../shared/agent-main-agent-verdict'
import { isCompletedPiCompatibleAgentWithLiveRecoveryRecord } from '../../../../../shared/live-resume-anchor-record'

export function collectSleepingAgentSessionRecordsForWorktree(
  state: AppState,
  worktreeId: string,
  options?: readonly string[] | CollectSleepingAgentSessionRecordsOptions
): Record<string, SleepingAgentSessionRecord> {
  const capturedAt = Date.now()
  const collectOptions = normalizeSleepingAgentSessionCollectOptions(options)
  const allowedPaneKeys = collectOptions.paneKeys ? new Set(collectOptions.paneKeys) : null
  const isManualWorktreeSleep = collectOptions.captureMode === 'manual-worktree-sleep'
  const isCompletedAgentHibernation = collectOptions.captureMode === 'completed-agent-hibernation'
  const isWorktreeOwnedCapture = isManualWorktreeSleep || isCompletedAgentHibernation
  // Completed hibernation is worktree-owned; wake treats originless completions as ambiguous legacy captures.
  const origin: SleepingAgentSessionRecord['origin'] | undefined = isWorktreeOwnedCapture
    ? 'worktree-sleep'
    : undefined
  const tabPrefixes = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
  const records: Record<string, SleepingAgentSessionRecord> = {}
  const promotedLiveRecoveryPaneKeys = new Set<string>()

  if (isManualWorktreeSleep) {
    for (const existing of Object.values(state.sleepingAgentSessionsByPaneKey)) {
      const liveEntry = state.agentStatusByPaneKey[existing.paneKey]
      if (
        existing.worktreeId !== worktreeId ||
        existing.origin !== 'live' ||
        (liveEntry !== undefined &&
          !isCompletedPiCompatibleAgentWithLiveRecoveryRecord(liveEntry, existing)) ||
        (allowedPaneKeys && !allowedPaneKeys.has(existing.paneKey)) ||
        !getAgentResumeArgv(existing.agent, existing.providerSession)
      ) {
        continue
      }
      // Pi resumes without turn status and while done/idle; manual sleep must promote these checkpoints too.
      records[existing.paneKey] = {
        ...existing,
        state: 'working',
        capturedAt,
        updatedAt: capturedAt,
        origin: 'worktree-sleep'
      }
      promotedLiveRecoveryPaneKeys.add(existing.paneKey)
    }
  }

  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    if (isCompletedAgentHibernation) {
      continue
    }
    if (allowedPaneKeys && !allowedPaneKeys.has(retained.entry.paneKey)) {
      continue
    }
    if (retained.worktreeId !== worktreeId) {
      continue
    }
    // Promoted checkpoint owns transcript/connection recovery identity; turn rows must not rederive over it.
    if (promotedLiveRecoveryPaneKeys.has(retained.entry.paneKey)) {
      continue
    }
    const record = sleepingRecordFromEntry({
      state,
      entry: isManualWorktreeSleep
        ? manualSleepCaptureEntry(retained.entry, capturedAt)
        : retained.entry,
      worktreeId,
      tab: retained.tab,
      capturedAt,
      launchConfig: getLaunchConfigForEntry(state, retained.entry),
      origin
    })
    if (record) {
      if (isManualWorktreeSleep) {
        markManualSleepLazyRestore(record)
      }
      records[record.paneKey] = record
    }
  }

  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (allowedPaneKeys && !allowedPaneKeys.has(paneKey)) {
      continue
    }
    // Promoted checkpoint owns transcript/connection recovery identity; turn rows must not rederive over it.
    if (promotedLiveRecoveryPaneKeys.has(paneKey)) {
      continue
    }
    const belongsToWorktree =
      entry.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
    if (!belongsToWorktree) {
      continue
    }
    if (isCompletedAgentHibernation && !isValidCompletedAgentHibernationEntry(entry)) {
      continue
    }
    const record = sleepingRecordFromEntry({
      state,
      entry: isManualWorktreeSleep ? manualSleepCaptureEntry(entry, capturedAt) : entry,
      worktreeId,
      capturedAt,
      launchConfig: getLaunchConfigForEntry(state, entry),
      origin
    })
    if (record) {
      if (isManualWorktreeSleep) {
        markManualSleepLazyRestore(record)
      }
      records[record.paneKey] = record
    }
  }

  return records
}

export function collectHibernatedCompletionEvidenceForWorktree(
  state: AppState,
  worktreeId: string,
  paneKeys?: readonly string[]
): RetainedAgentEntry[] {
  const allowedPaneKeys = normalizePaneKeySet(paneKeys)
  if (!allowedPaneKeys || allowedPaneKeys.size === 0) {
    return []
  }
  const tabPrefixes = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
  const retained: RetainedAgentEntry[] = []
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    const agentType = entry.agentType
    if (
      !allowedPaneKeys.has(paneKey) ||
      entry.state !== 'done' ||
      agentType === undefined ||
      agentTurnEndedOnPurpose(entry)
    ) {
      continue
    }
    const belongsToWorktree =
      entry.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
    if (!belongsToWorktree) {
      continue
    }
    retained.push(retainedAgentEntryFromLive(state, worktreeId, entry, agentType))
  }
  return retained
}
