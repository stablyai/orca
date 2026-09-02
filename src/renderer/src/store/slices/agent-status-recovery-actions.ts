import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import { collectSleepingAgentSessionRecordsForWorktree } from './agent-status-recovery-collection'
import {
  removeSleepingRecordsReplacedByManualWorktreeSleep,
  sleepingRecordFromEntry
} from './agent-status-sleeping-records'
import {
  recoveryRecordTargetsSameSession,
  sleepingRecordsEquivalentIgnoringCaptureTime
} from './agent-status-recovery-equivalence'
import { getLaunchConfigForEntry } from './agent-status-launch-config'
import { findAgentPaneWorktreeId } from './agent-status-pane-key-tab-binding'
import { isCompletedPiCompatibleAgentWithLiveRecoveryRecord } from '@/lib/live-resume-anchor-record'

export function createAgentStatusRecoveryActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  | 'captureSleepingAgentSessionsByWorktree'
  | 'captureAllSleepingAgentSessions'
  | 'clearSleepingAgentSession'
  | 'clearSleepingAgentSessionsByPaneKey'
  | 'setSleepingAgentAutomaticResumeBlocked'
  | 'clearSleepingAgentSessionsByWorktree'
  | 'pruneSleepingAgentSessions'
> {
  const { set, clearSleepingAgentSessionsByPaneKey } = runtime
  return {
    captureSleepingAgentSessionsByWorktree: (worktreeId, paneKeys) => {
      set((s) => {
        const records = collectSleepingAgentSessionRecordsForWorktree(s, worktreeId, {
          paneKeys,
          captureMode: 'manual-worktree-sleep'
        })
        const replaced = removeSleepingRecordsReplacedByManualWorktreeSleep(
          s.sleepingAgentSessionsByPaneKey,
          worktreeId,
          paneKeys,
          records
        )
        let next = { ...replaced.records }
        let changed = replaced.changed
        for (const record of Object.values(records)) {
          if (next[record.paneKey] !== record) {
            next[record.paneKey] = record
            changed = true
          }
        }
        return changed ? { sleepingAgentSessionsByPaneKey: next } : s
      })
    },

    captureAllSleepingAgentSessions: (mode) => {
      set((s) => {
        const capturedAt = Date.now()
        const origin = mode === 'quit' ? ('quit' as const) : ('live' as const)
        const next: Record<string, SleepingAgentSessionRecord> = {
          ...s.sleepingAgentSessionsByPaneKey
        }
        let changed = false
        for (const entry of Object.values(s.agentStatusByPaneKey)) {
          if (entry.state === 'done') {
            const existing = next[entry.paneKey]
            if (
              !isCompletedPiCompatibleAgentWithLiveRecoveryRecord(entry, existing) ||
              mode === 'periodic'
            ) {
              continue
            }
            const record = { ...existing, capturedAt, origin }
            if (!sleepingRecordsEquivalentIgnoringCaptureTime(existing, record)) {
              next[entry.paneKey] = record
              changed = true
            }
            continue
          }
          const worktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey)
          if (!worktreeId) {
            continue
          }
          const record = sleepingRecordFromEntry({
            state: s,
            entry,
            worktreeId,
            capturedAt,
            launchConfig: getLaunchConfigForEntry(s, entry),
            origin
          })
          const existing = next[entry.paneKey]
          if (
            mode === 'periodic' &&
            existing?.origin === 'quit' &&
            record &&
            recoveryRecordTargetsSameSession(existing, record)
          ) {
            continue
          }
          if (record && !sleepingRecordsEquivalentIgnoringCaptureTime(existing, record)) {
            next[record.paneKey] = record
            changed = true
          }
        }
        return changed ? { sleepingAgentSessionsByPaneKey: next } : s
      })
    },

    clearSleepingAgentSession: (paneKey) => clearSleepingAgentSessionsByPaneKey([paneKey]),
    clearSleepingAgentSessionsByPaneKey,

    setSleepingAgentAutomaticResumeBlocked: (paneKey, blocked) => {
      set((s) => {
        const current = s.sleepingAgentSessionsByPaneKey[paneKey]
        if (
          !current ||
          (blocked
            ? current.automaticResumeBlockedBy === 'legacy-orchestration-worker'
            : current.automaticResumeBlockedBy === undefined)
        ) {
          return s
        }
        const next = { ...current }
        if (blocked) {
          next.automaticResumeBlockedBy = 'legacy-orchestration-worker'
        } else {
          delete next.automaticResumeBlockedBy
        }
        return {
          sleepingAgentSessionsByPaneKey: {
            ...s.sleepingAgentSessionsByPaneKey,
            [paneKey]: next
          }
        }
      })
    },

    clearSleepingAgentSessionsByWorktree: (worktreeId) => {
      set((s) => {
        let changed = false
        const next: Record<string, SleepingAgentSessionRecord> = {}
        const removed: string[] = []
        for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
          if (record.worktreeId === worktreeId) {
            changed = true
            removed.push(paneKey)
          } else {
            next[paneKey] = record
          }
        }
        if (!changed) {
          return s
        }
        const nextLaunch =
          removed.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : s.agentLaunchConfigByPaneKey
        for (const paneKey of removed) {
          delete nextLaunch[paneKey]
        }
        return {
          sleepingAgentSessionsByPaneKey: next,
          ...(nextLaunch !== s.agentLaunchConfigByPaneKey
            ? { agentLaunchConfigByPaneKey: nextLaunch }
            : {})
        }
      })
    },

    pruneSleepingAgentSessions: (validWorktreeIds) => {
      set((s) => {
        let changed = false
        const next: Record<string, SleepingAgentSessionRecord> = {}
        const removed: string[] = []
        for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
          if (!validWorktreeIds.has(record.worktreeId)) {
            changed = true
            removed.push(paneKey)
          } else {
            next[paneKey] = record
          }
        }
        if (!changed) {
          return s
        }
        const nextLaunch =
          removed.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : s.agentLaunchConfigByPaneKey
        for (const paneKey of removed) {
          delete nextLaunch[paneKey]
        }
        return {
          sleepingAgentSessionsByPaneKey: next,
          ...(nextLaunch !== s.agentLaunchConfigByPaneKey
            ? { agentLaunchConfigByPaneKey: nextLaunch }
            : {})
        }
      })
    }
  }
}
