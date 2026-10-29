import { editSessionSource } from '@/store/session-source-edits'
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
        const edit = editSessionSource(s)
        let changed = removeSleepingRecordsReplacedByManualWorktreeSleep(
          edit,
          worktreeId,
          paneKeys,
          records
        )
        for (const record of Object.values(records)) {
          if (edit.read('sleepingAgentSessionsByPaneKey')[record.paneKey] !== record) {
            edit.set('sleepingAgentSessionsByPaneKey', record.paneKey, record)
            changed = true
          }
        }
        return changed ? edit.finish() : undefined
      })
    },

    captureAllSleepingAgentSessions: (mode) => {
      set((s) => {
        const capturedAt = Date.now()
        const edit = editSessionSource(s)
        let changed = false
        for (const entry of Object.values(s.agentStatusByPaneKey)) {
          const record = capturedResumeRecord({
            entry,
            existing: edit.read('sleepingAgentSessionsByPaneKey')[entry.paneKey],
            mode,
            capturedAt,
            worktreeIdOf: () => entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey),
            tabOf: (worktreeId) => findTabForAgentEntry(s, worktreeId, entry),
            launchConfigOf: () => getLaunchConfigForEntry(s, entry)
          })
          if (record) {
            edit.set('sleepingAgentSessionsByPaneKey', record.paneKey, record)
            changed = true
          }
        }
        return changed ? edit.finish() : undefined
      })
    },

    clearSleepingAgentSession: (paneKey) => clearSleepingAgentSessionsByPaneKey([paneKey]),

    rememberSleepingAgentSession: (record) => {
      set((s) =>
        s.sleepingAgentSessionsByPaneKey[record.paneKey]
          ? undefined
          : editSessionSource(s)
              .set('sleepingAgentSessionsByPaneKey', record.paneKey, record)
              .finish({})
      )
    },
    clearSleepingAgentSessionsByPaneKey,

    clearSleepingAgentSessionsByWorktree: (worktreeId) => {
      set((s) => {
        let changed = false
        const edit = editSessionSource(s)
        const removed: string[] = []
        for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
          if (record.worktreeId === worktreeId) {
            changed = true
            removed.push(paneKey)
            edit.remove('sleepingAgentSessionsByPaneKey', paneKey)
          }
        }
        if (!changed) {
          return undefined
        }
        const nextLaunch =
          removed.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : s.agentLaunchConfigByPaneKey
        for (const paneKey of removed) {
          delete nextLaunch[paneKey]
        }
        return edit.finish({
          agentLaunchConfigByPaneKey: nextLaunch
        })
      })
    },

    pruneSleepingAgentSessions: (validWorktreeIds) => {
      set((s) => {
        let changed = false
        const edit = editSessionSource(s)
        const removed: string[] = []
        for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
          if (!validWorktreeIds.has(record.worktreeId)) {
            changed = true
            removed.push(paneKey)
            edit.remove('sleepingAgentSessionsByPaneKey', paneKey)
          }
        }
        if (!changed) {
          return undefined
        }
        const nextLaunch =
          removed.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : s.agentLaunchConfigByPaneKey
        for (const paneKey of removed) {
          delete nextLaunch[paneKey]
        }
        return edit.finish({
          agentLaunchConfigByPaneKey: nextLaunch
        })
      })
    }
  }
}
