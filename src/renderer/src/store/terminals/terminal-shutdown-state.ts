import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { clearTransientTerminalState } from '../slices/terminal-helpers'
import {
  clearCommittedPtyShutdownSettlements,
  markCommittedPtyShutdowns,
  settleDeferredPtyShutdownExits
} from '@/components/terminal-pane/pty-shutdown-exit-deferral'
import {
  removeSleepingRecordsReplacedByManualWorktreeSleep,
  type AgentStatusWorktreeShutdownReason,
  type RetainedAgentEntry
} from '../slices/agent-status'
import type { TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { copyOnWriteRecord } from '../copy-on-write-record'

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
  set((state) => {
    const tabsByWorktree = keepIdentifiers
      ? state.tabsByWorktree
      : {
          ...state.tabsByWorktree,
          [worktreeId]: (state.tabsByWorktree[worktreeId] ?? []).map((tab, index) =>
            clearTransientTerminalState(tab, index)
          )
        }
    // Why copy-on-write everywhere below: a worktree whose panes already exited hits
    // this with nothing to clear, and unconditional spreads then hand every map a new
    // identity for no data change. ptyIdsByTabId is the costly one — six components
    // select it whole, and selectLivePtyIdsForWorktree memoizes per sidebar card on
    // its identity, so churning it rebuilds that record once per card.
    const ptyIdsByTabId = copyOnWriteRecord(state.ptyIdsByTabId)
    for (const tab of tabs) {
      // Why `!== undefined`: an absent key is not an empty array, and the spread this
      // replaces created the key. Only an already-empty entry can be skipped.
      const current = state.ptyIdsByTabId[tab.id]
      if (current === undefined || current.length > 0) {
        ptyIdsByTabId.set(tab.id, [])
      }
    }
    const suppressedPtyExitIds = copyOnWriteRecord(state.suppressedPtyExitIds)
    const pendingPtyShutdownIds = copyOnWriteRecord(state.pendingPtyShutdownIds)
    const pendingCodexPaneRestartIds = copyOnWriteRecord(state.pendingCodexPaneRestartIds)
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
        pendingCodexPaneRestartIds.delete(ptyId)
      }
      codexRestartNoticeByPtyId.delete(ptyId)
    }

    const runtimePaneTitlesByTabId = copyOnWriteRecord(state.runtimePaneTitlesByTabId)
    const pendingSetupSplitByTabId = copyOnWriteRecord(state.pendingSetupSplitByTabId)
    const pendingIssueCommandSplitByTabId = copyOnWriteRecord(state.pendingIssueCommandSplitByTabId)
    const terminalLayoutsByTabId = copyOnWriteRecord(state.terminalLayoutsByTabId)
    const lastKnownRelayPtyIdByTabId = copyOnWriteRecord(state.lastKnownRelayPtyIdByTabId)
    const unreadTerminalTabs = copyOnWriteRecord(state.unreadTerminalTabs)
    const unreadTerminalPanes = copyOnWriteRecord(state.unreadTerminalPanes)
    const unreadAgentCompletionPanes = copyOnWriteRecord(state.unreadAgentCompletionPanes)
    const lastTerminalInputAtByPaneKey = copyOnWriteRecord(state.lastTerminalInputAtByPaneKey)

    for (const tab of tabs) {
      pendingSetupSplitByTabId.delete(tab.id)
      pendingIssueCommandSplitByTabId.delete(tab.id)
      unreadTerminalTabs.delete(tab.id)
      const panePrefix = `${tab.id}:`
      for (const paneKey of Object.keys(state.unreadTerminalPanes)) {
        if (paneKey.startsWith(panePrefix)) {
          unreadTerminalPanes.delete(paneKey)
        }
      }
      for (const paneKey of Object.keys(state.unreadAgentCompletionPanes)) {
        if (paneKey.startsWith(panePrefix)) {
          unreadAgentCompletionPanes.delete(paneKey)
        }
      }
      for (const paneKey of Object.keys(state.lastTerminalInputAtByPaneKey)) {
        if (paneKey.startsWith(panePrefix)) {
          lastTerminalInputAtByPaneKey.delete(paneKey)
        }
      }
      if (!keepIdentifiers) {
        runtimePaneTitlesByTabId.delete(tab.id)
        lastKnownRelayPtyIdByTabId.delete(tab.id)
        const layout = state.terminalLayoutsByTabId[tab.id]
        // Why the emptiness check: replacing an already-empty map with a fresh {} is
        // the same value with a new identity.
        if (layout?.ptyIdsByLeafId && Object.keys(layout.ptyIdsByLeafId).length > 0) {
          terminalLayoutsByTabId.set(tab.id, { ...layout, ptyIdsByLeafId: {} })
        }
      }
    }

    return {
      tabsByWorktree,
      ptyIdsByTabId: ptyIdsByTabId.read(),
      lastKnownRelayPtyIdByTabId: lastKnownRelayPtyIdByTabId.read(),
      runtimePaneTitlesByTabId: runtimePaneTitlesByTabId.read(),
      suppressedPtyExitIds: suppressedPtyExitIds.read(),
      pendingPtyShutdownIds: pendingPtyShutdownIds.read(),
      pendingCodexPaneRestartIds: pendingCodexPaneRestartIds.read(),
      codexRestartNoticeByPtyId: codexRestartNoticeByPtyId.read(),
      pendingSetupSplitByTabId: pendingSetupSplitByTabId.read(),
      pendingIssueCommandSplitByTabId: pendingIssueCommandSplitByTabId.read(),
      terminalLayoutsByTabId: terminalLayoutsByTabId.read(),
      unreadTerminalTabs: unreadTerminalTabs.read(),
      unreadTerminalPanes: unreadTerminalPanes.read(),
      unreadAgentCompletionPanes: unreadAgentCompletionPanes.read(),
      lastTerminalInputAtByPaneKey: lastTerminalInputAtByPaneKey.read()
    }
  })

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
        sleepingAgentSessionsByPaneKey: {
          ...base,
          ...sleepingAgentSessionRecords
        }
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
