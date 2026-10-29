import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { clearTransientTerminalState } from '../slices/terminal-helpers'
import {
  clearCommittedPtyShutdownSettlements,
  markCommittedPtyShutdowns,
  settleDeferredPtyShutdownExits
} from '@/components/terminal-pane/pty-shutdown-exit-deferral'
import '../slices/agent-status/agent-status'
import { removeSleepingRecordsReplacedByManualWorktreeSleep } from '../slices/agent-status/agent-status-sleeping-records'
import type {
  AgentStatusWorktreeShutdownReason,
  RetainedAgentEntry
} from '../slices/agent-status/agent-status-contract'
import type { TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { copyOnWriteRecord } from '../copy-on-write-record'
import { removeTabsAttention } from '../slices/workspace-attention/subject-attention-transitions'
import { settleAttentionRemovedBy } from '../slices/workspace-attention/attention-removal-follow-up'
import { editSessionSource } from '../session-source-edits'

export function commitTerminalShutdownState({
  exitGuardPtyIds,
  get,
  keepIdentifiers,
  retainedCompletionEvidence,
  set,
  shutdownReason,
  sleepingAgentSessionRecords,
  sleepingPaneKeys,
  tabs,
  worktreeId
}: {
  exitGuardPtyIds: readonly string[]
  get: TerminalStoreGet
  keepIdentifiers: boolean
  retainedCompletionEvidence: readonly RetainedAgentEntry[]
  set: TerminalStoreSet
  shutdownReason: AgentStatusWorktreeShutdownReason
  sleepingAgentSessionRecords: Record<string, SleepingAgentSessionRecord>
  sleepingPaneKeys?: readonly string[]
  tabs: readonly TerminalTab[]
  worktreeId: string
}): void {
  settleAttentionRemovedBy(set, get, () =>
    set((state) => {
      const edit = editSessionSource(state)
      if (!keepIdentifiers) {
        edit.set(
          'tabsByWorktree',
          worktreeId,
          (state.tabsByWorktree[worktreeId] ?? []).map((tab, index) =>
            clearTransientTerminalState(tab, index)
          )
        )
      }
      // Use copy-on-write for already-exited workspaces; churning ptyIdsByTabId invalidates whole-map selectors and every sidebar live-PTY memo.
      for (const tab of tabs) {
        // Why `!== undefined`: an absent key is not an empty array, and the spread this
        // replaces created the key. Only an already-empty entry can be skipped.
        const current = state.ptyIdsByTabId[tab.id]
        if (current === undefined || current.length > 0) {
          edit.set('ptyIdsByTabId', tab.id, [])
        }
      }
      const suppressedPtyExitIds = copyOnWriteRecord(state.suppressedPtyExitIds)
      const pendingPtyShutdownIds = copyOnWriteRecord(state.pendingPtyShutdownIds)
      const pendingPaneAccountRestarts = copyOnWriteRecord(state.pendingPaneAccountRestarts)
      const codexRestartNoticeByPtyId = copyOnWriteRecord(state.codexRestartNoticeByPtyId)
      for (const ptyId of exitGuardPtyIds) {
        if (state.suppressedPtyExitIds[ptyId] !== true) {
          suppressedPtyExitIds.set(ptyId, true)
        }
        // An absent owner count meant `delete` of a missing key, which changed nothing.
        if (ptyId in state.pendingPtyShutdownIds) {
          const remainingOwners = (state.pendingPtyShutdownIds[ptyId] ?? 0) - 1
          if (remainingOwners > 0) {
            pendingPtyShutdownIds.set(ptyId, remainingOwners)
          } else {
            pendingPtyShutdownIds.delete(ptyId)
          }
        }
        // Sleeping terminals retain restart intent, but a wake can receive a different live PTY id.
        if (!keepIdentifiers) {
          pendingPaneAccountRestarts.delete(ptyId)
        }
        codexRestartNoticeByPtyId.delete(ptyId)
      }

      const runtimePaneTitlesByTabId = copyOnWriteRecord(state.runtimePaneTitlesByTabId)
      const pendingIssueCommandSplitByTabId = copyOnWriteRecord(
        state.pendingIssueCommandSplitByTabId
      )
      const lastTerminalInputAtByPaneKey = copyOnWriteRecord(state.lastTerminalInputAtByPaneKey)

      for (const tab of tabs) {
        pendingIssueCommandSplitByTabId.delete(tab.id)
        const panePrefix = `${tab.id}:`
        for (const paneKey of Object.keys(state.lastTerminalInputAtByPaneKey)) {
          if (paneKey.startsWith(panePrefix)) {
            lastTerminalInputAtByPaneKey.delete(paneKey)
          }
        }
        if (!keepIdentifiers) {
          runtimePaneTitlesByTabId.delete(tab.id)
          edit.remove('lastKnownRelayPtyIdByTabId', tab.id)
          const layout = state.terminalLayoutsByTabId[tab.id]
          // Why the emptiness check: replacing an already-empty map with a fresh {} is
          // the same value with a new identity.
          if (layout?.ptyIdsByLeafId && Object.keys(layout.ptyIdsByLeafId).length > 0) {
            edit.set('terminalLayoutsByTabId', tab.id, { ...layout, ptyIdsByLeafId: {} })
          }
        }
      }

      return edit.finish({
        runtimePaneTitlesByTabId: runtimePaneTitlesByTabId.read(),
        suppressedPtyExitIds: suppressedPtyExitIds.read(),
        pendingPtyShutdownIds: pendingPtyShutdownIds.read(),
        pendingPaneAccountRestarts: pendingPaneAccountRestarts.read(),
        codexRestartNoticeByPtyId: codexRestartNoticeByPtyId.read(),
        pendingIssueCommandSplitByTabId: pendingIssueCommandSplitByTabId.read(),
        ...removeTabsAttention(
          state,
          tabs.map((tab) => tab.id)
        ),
        lastTerminalInputAtByPaneKey: lastTerminalInputAtByPaneKey.read()
      })
    })
  )

  if (keepIdentifiers) {
    set((state) => {
      const edit = editSessionSource(state)
      if (shutdownReason === 'manual-sleep') {
        removeSleepingRecordsReplacedByManualWorktreeSleep(
          edit,
          worktreeId,
          sleepingPaneKeys,
          sleepingAgentSessionRecords
        )
      }
      for (const [paneKey, record] of Object.entries(sleepingAgentSessionRecords)) {
        edit.set('sleepingAgentSessionsByPaneKey', paneKey, record)
      }
      return edit.finish()
    })
  } else {
    get().clearSleepingAgentSessionsByWorktree(worktreeId)
  }

  get().dropAgentStatusByWorktree(worktreeId, {
    shutdownReason,
    sleepingPaneKeys,
    retainedCompletionEvidence
  })
  get().clearPaneForegroundAgentByWorktree(worktreeId)
  const settledPtyIds = exitGuardPtyIds.filter((ptyId) => !get().isPtyShutdownPending(ptyId))
  markCommittedPtyShutdowns(settledPtyIds)
  settleDeferredPtyShutdownExits(settledPtyIds, 'committed')
  clearCommittedPtyShutdownSettlements(settledPtyIds)
}
