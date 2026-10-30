import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import { collectSleepingAgentSessionRecordsForWorktree } from './agent-status-recovery-collection'
import { removeSleepingRecordsReplacedByManualWorktreeSleep } from './agent-status-sleeping-records'
import { capturedResumeRecord } from '../../../../../shared/agent-resume-record-from-status'
import { getLaunchConfigForEntry } from './agent-status-launch-config'
import { findAgentPaneWorktreeId, findTabForAgentEntry } from './agent-status-pane-key-tab-binding'

export function createAgentStatusRecoveryActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  | 'captureSleepingAgentSessionsByWorktree'
  | 'captureAllSleepingAgentSessions'
  | 'clearSleepingAgentSession'
  | 'rememberSleepingAgentSession'
  | 'clearSleepingAgentSessionsByPaneKey'
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
        const next: Record<string, SleepingAgentSessionRecord> = {
          ...s.sleepingAgentSessionsByPaneKey
        }
        let changed = false
        for (const entry of Object.values(s.agentStatusByPaneKey)) {
          const record = capturedResumeRecord({
            entry,
            existing: next[entry.paneKey],
            mode,
            capturedAt,
            worktreeIdOf: () => entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey),
            tabOf: (worktreeId) => findTabForAgentEntry(s, worktreeId, entry),
            launchConfigOf: () => getLaunchConfigForEntry(s, entry)
          })
          if (record) {
            next[record.paneKey] = record
            changed = true
          }
        }
        return changed ? { sleepingAgentSessionsByPaneKey: next } : s
      })
    },

    clearSleepingAgentSession: (paneKey) => clearSleepingAgentSessionsByPaneKey([paneKey]),

    rememberSleepingAgentSession: (record) => {
      set((s) =>
        s.sleepingAgentSessionsByPaneKey[record.paneKey]
          ? s
          : {
              sleepingAgentSessionsByPaneKey: {
                ...s.sleepingAgentSessionsByPaneKey,
                [record.paneKey]: record
              }
            }
      )
    },
    clearSleepingAgentSessionsByPaneKey,

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
