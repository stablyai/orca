import type { AppState } from '../../types'
import { sleepingAgentRecordIndex } from '../../terminals/sleeping-agent-record-index'
import '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { getAgentResumeArgv } from '../../../../../shared/agent-launch/startup/agent-resume-argv'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { paneKeyMatchesAnyTabPrefix } from './agent-status-pane-key-tab-binding'
import {
  isValidCompletedAgentHibernationEntry,
  manualSleepCaptureEntry,
  markManualSleepLazyRestore,
  normalizeSleepingAgentSessionCollectOptions,
  sleepingRecordFromEntry,
  type CollectSleepingAgentSessionRecordsOptions
} from './agent-status-sleeping-records'
import { getLaunchConfigForEntry } from './agent-status-launch-config'
import { isCompletedPiCompatibleAgentWithLiveRecoveryRecord } from '../../../../../shared/agent-session/lifecycle/live-resume-anchor-record'

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
    for (const [, existing] of sleepingAgentRecordIndex.entries(
      state.sleepingAgentSessionsByPaneKey,
      worktreeId
    )) {
      const liveEntry = state.agentStatusByPaneKey.get(existing.paneKey)
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

  for (const [paneKey, entry] of Array.from(state.agentStatusByPaneKey.entries())) {
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
