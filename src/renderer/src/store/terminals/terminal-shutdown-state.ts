import { replaceTabBuckets, replaceRecordEntries } from '@/store/keyed-record-transitions'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../shared/workspace-layout/terminal-tab-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { clearTransientTerminalState } from './terminal-transient-state'
import {
  clearCommittedPtyShutdownSettlements,
  markCommittedPtyShutdowns,
  settleDeferredPtyShutdownExits
} from '@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-exit-deferral'
import '../slices/agent-status/agent-status'
import { removeSleepingRecordsReplacedByManualWorktreeSleep } from '../slices/agent-status/agent-status-sleeping-records'
import type {
  AgentStatusWorktreeShutdownReason,
  RetainedAgentEntry
} from '../slices/agent-status/agent-status-contract'
import type { TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { copyOnWriteRecord } from './terminal-shutdown-record'
import { removeTabsAttention } from '../slices/workspace-attention/subject-attention-transitions'
import { settleAttentionRemovedBy } from '../slices/workspace-attention/attention-removal-follow-up'

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
      const tabsByWorktree = keepIdentifiers
        ? state.tabsByWorktree
        : replaceTabBuckets(state.tabsByWorktree, [
            [
              worktreeId,
              (state.tabsByWorktree[worktreeId] ?? []).map((tab, index) =>
                clearTransientTerminalState(tab, index)
              )
            ]
          ])
      // Use copy-on-write for already-exited workspaces; churning ptyIdsByTabId invalidates whole-map selectors and every sidebar live-PTY memo.
      const ptyReplacements: [string, string[]][] = []
      for (const tab of tabs) {
        // Why `!== undefined`: an absent key is not an empty array, and the spread this
        // replaces created the key. Only an already-empty entry can be skipped.
        const current = state.ptyIdsByTabId[tab.id]
        if (current === undefined || current.length > 0) {
          ptyReplacements.push([tab.id, []])
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

      const titleDeletions: [string, null][] = []
      const pendingIssueCommandSplitByTabId = copyOnWriteRecord(
        state.pendingIssueCommandSplitByTabId
      )
      const layoutReplacements: [string, TerminalLayoutSnapshot][] = []
      const relayDeletions: [string, null][] = []
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
          if (tab.id in state.runtimePaneTitlesByTabId) {
            titleDeletions.push([tab.id, null])
          }
          if (tab.id in state.lastKnownRelayPtyIdByTabId) {
            relayDeletions.push([tab.id, null])
          }
          const layout = state.terminalLayoutsByTabId[tab.id]
          // Why the emptiness check: replacing an already-empty map with a fresh {} is
          // the same value with a new identity.
          if (layout?.ptyIdsByLeafId && Object.keys(layout.ptyIdsByLeafId).length > 0) {
            layoutReplacements.push([tab.id, { ...layout, ptyIdsByLeafId: {} }])
          }
        }
      }

      return {
        tabsByWorktree,
        ptyIdsByTabId:
          ptyReplacements.length > 0
            ? replaceRecordEntries(state.ptyIdsByTabId, ptyReplacements)
            : state.ptyIdsByTabId,
        lastKnownRelayPtyIdByTabId:
          relayDeletions.length > 0
            ? replaceRecordEntries<string>(state.lastKnownRelayPtyIdByTabId, relayDeletions)
            : state.lastKnownRelayPtyIdByTabId,
        runtimePaneTitlesByTabId:
          titleDeletions.length > 0
            ? replaceRecordEntries<Record<number, string>>(
                state.runtimePaneTitlesByTabId,
                titleDeletions
              )
            : state.runtimePaneTitlesByTabId,
        suppressedPtyExitIds: suppressedPtyExitIds.read(),
        pendingPtyShutdownIds: pendingPtyShutdownIds.read(),
        pendingPaneAccountRestarts: pendingPaneAccountRestarts.read(),
        codexRestartNoticeByPtyId: codexRestartNoticeByPtyId.read(),
        pendingIssueCommandSplitByTabId: pendingIssueCommandSplitByTabId.read(),
        terminalLayoutsByTabId:
          layoutReplacements.length > 0
            ? replaceRecordEntries(state.terminalLayoutsByTabId, layoutReplacements)
            : state.terminalLayoutsByTabId,
        ...removeTabsAttention(
          state,
          tabs.map((tab) => tab.id)
        ),
        lastTerminalInputAtByPaneKey: lastTerminalInputAtByPaneKey.read()
      }
    })
  )

  if (keepIdentifiers) {
    set((state) => {
      const base =
        shutdownReason === 'manual-sleep'
          ? removeSleepingRecordsReplacedByManualWorktreeSleep(
              state.sleepingAgentSessionsByPaneKey,
              worktreeId,
              sleepingPaneKeys,
              sleepingAgentSessionRecords
            ).records
          : state.sleepingAgentSessionsByPaneKey
      return {
        sleepingAgentSessionsByPaneKey: replaceRecordEntries(
          base,
          Object.entries(sleepingAgentSessionRecords)
        )
      }
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
