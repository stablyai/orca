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
    // The four unread/input maps below already use this shape; this matches them.
    let ptyIdsByTabId = state.ptyIdsByTabId
    for (const tab of tabs) {
      const current = ptyIdsByTabId[tab.id]
      // Why `!== undefined`: an absent key is not an empty array, and the spread this
      // replaces created the key. Only an already-empty entry can be skipped.
      if (current !== undefined && current.length === 0) {
        continue
      }
      if (ptyIdsByTabId === state.ptyIdsByTabId) {
        ptyIdsByTabId = { ...state.ptyIdsByTabId }
      }
      ptyIdsByTabId[tab.id] = []
    }
    let runtimePaneTitlesByTabId = state.runtimePaneTitlesByTabId
    let suppressedPtyExitIds = state.suppressedPtyExitIds
    for (const ptyId of exitGuardPtyIds) {
      if (suppressedPtyExitIds[ptyId] === true) {
        continue
      }
      if (suppressedPtyExitIds === state.suppressedPtyExitIds) {
        suppressedPtyExitIds = { ...state.suppressedPtyExitIds }
      }
      suppressedPtyExitIds[ptyId] = true
    }
    let pendingPtyShutdownIds = state.pendingPtyShutdownIds
    for (const ptyId of exitGuardPtyIds) {
      // An absent owner count meant `delete` of a missing key, which changed nothing.
      if (!(ptyId in pendingPtyShutdownIds)) {
        continue
      }
      const remainingOwners = (pendingPtyShutdownIds[ptyId] ?? 0) - 1
      if (pendingPtyShutdownIds === state.pendingPtyShutdownIds) {
        pendingPtyShutdownIds = { ...state.pendingPtyShutdownIds }
      }
      if (remainingOwners > 0) {
        pendingPtyShutdownIds[ptyId] = remainingOwners
      } else {
        delete pendingPtyShutdownIds[ptyId]
      }
    }

    // Sleeping terminals retain restart intent, but a wake can receive a different live PTY id.
    let pendingCodexPaneRestartIds = state.pendingCodexPaneRestartIds
    let codexRestartNoticeByPtyId = state.codexRestartNoticeByPtyId
    for (const ptyId of exitGuardPtyIds) {
      if (!keepIdentifiers && ptyId in pendingCodexPaneRestartIds) {
        if (pendingCodexPaneRestartIds === state.pendingCodexPaneRestartIds) {
          pendingCodexPaneRestartIds = { ...state.pendingCodexPaneRestartIds }
        }
        delete pendingCodexPaneRestartIds[ptyId]
      }
      if (ptyId in codexRestartNoticeByPtyId) {
        if (codexRestartNoticeByPtyId === state.codexRestartNoticeByPtyId) {
          codexRestartNoticeByPtyId = { ...state.codexRestartNoticeByPtyId }
        }
        delete codexRestartNoticeByPtyId[ptyId]
      }
    }

    let pendingSetupSplitByTabId = state.pendingSetupSplitByTabId
    let pendingIssueCommandSplitByTabId = state.pendingIssueCommandSplitByTabId
    let terminalLayoutsByTabId = state.terminalLayoutsByTabId
    let unreadTerminalTabs = state.unreadTerminalTabs
    let unreadTerminalPanes = state.unreadTerminalPanes
    let unreadAgentCompletionPanes = state.unreadAgentCompletionPanes
    let lastTerminalInputAtByPaneKey = state.lastTerminalInputAtByPaneKey

    for (const tab of tabs) {
      if (!keepIdentifiers && tab.id in runtimePaneTitlesByTabId) {
        if (runtimePaneTitlesByTabId === state.runtimePaneTitlesByTabId) {
          runtimePaneTitlesByTabId = { ...state.runtimePaneTitlesByTabId }
        }
        delete runtimePaneTitlesByTabId[tab.id]
      }
      if (tab.id in pendingSetupSplitByTabId) {
        if (pendingSetupSplitByTabId === state.pendingSetupSplitByTabId) {
          pendingSetupSplitByTabId = { ...state.pendingSetupSplitByTabId }
        }
        delete pendingSetupSplitByTabId[tab.id]
      }
      if (tab.id in pendingIssueCommandSplitByTabId) {
        if (pendingIssueCommandSplitByTabId === state.pendingIssueCommandSplitByTabId) {
          pendingIssueCommandSplitByTabId = { ...state.pendingIssueCommandSplitByTabId }
        }
        delete pendingIssueCommandSplitByTabId[tab.id]
      }
      if (unreadTerminalTabs[tab.id]) {
        if (unreadTerminalTabs === state.unreadTerminalTabs) {
          unreadTerminalTabs = { ...state.unreadTerminalTabs }
        }
        delete unreadTerminalTabs[tab.id]
      }
      for (const paneKey of Object.keys(unreadTerminalPanes)) {
        if (paneKey.startsWith(`${tab.id}:`)) {
          if (unreadTerminalPanes === state.unreadTerminalPanes) {
            unreadTerminalPanes = { ...unreadTerminalPanes }
          }
          delete unreadTerminalPanes[paneKey]
        }
      }
      for (const paneKey of Object.keys(unreadAgentCompletionPanes)) {
        if (paneKey.startsWith(`${tab.id}:`)) {
          if (unreadAgentCompletionPanes === state.unreadAgentCompletionPanes) {
            unreadAgentCompletionPanes = { ...unreadAgentCompletionPanes }
          }
          delete unreadAgentCompletionPanes[paneKey]
        }
      }
      for (const paneKey of Object.keys(lastTerminalInputAtByPaneKey)) {
        if (paneKey.startsWith(`${tab.id}:`)) {
          if (lastTerminalInputAtByPaneKey === state.lastTerminalInputAtByPaneKey) {
            lastTerminalInputAtByPaneKey = { ...lastTerminalInputAtByPaneKey }
          }
          delete lastTerminalInputAtByPaneKey[paneKey]
        }
      }
      if (!keepIdentifiers) {
        const layout = terminalLayoutsByTabId[tab.id]
        // Why the emptiness check: replacing an already-empty map with a fresh {} is
        // the same value with a new identity.
        if (layout?.ptyIdsByLeafId && Object.keys(layout.ptyIdsByLeafId).length > 0) {
          if (terminalLayoutsByTabId === state.terminalLayoutsByTabId) {
            terminalLayoutsByTabId = { ...state.terminalLayoutsByTabId }
          }
          terminalLayoutsByTabId[tab.id] = { ...layout, ptyIdsByLeafId: {} }
        }
      }
    }

    let lastKnownRelayPtyIdByTabId = state.lastKnownRelayPtyIdByTabId
    if (!keepIdentifiers) {
      for (const tab of tabs) {
        if (!(tab.id in lastKnownRelayPtyIdByTabId)) {
          continue
        }
        if (lastKnownRelayPtyIdByTabId === state.lastKnownRelayPtyIdByTabId) {
          lastKnownRelayPtyIdByTabId = { ...state.lastKnownRelayPtyIdByTabId }
        }
        delete lastKnownRelayPtyIdByTabId[tab.id]
      }
    }

    return {
      tabsByWorktree,
      ptyIdsByTabId,
      lastKnownRelayPtyIdByTabId,
      runtimePaneTitlesByTabId,
      suppressedPtyExitIds,
      pendingPtyShutdownIds,
      pendingCodexPaneRestartIds,
      codexRestartNoticeByPtyId,
      pendingSetupSplitByTabId,
      pendingIssueCommandSplitByTabId,
      terminalLayoutsByTabId,
      ...(unreadTerminalTabs !== state.unreadTerminalTabs ? { unreadTerminalTabs } : {}),
      ...(unreadTerminalPanes !== state.unreadTerminalPanes ? { unreadTerminalPanes } : {}),
      ...(unreadAgentCompletionPanes !== state.unreadAgentCompletionPanes
        ? { unreadAgentCompletionPanes }
        : {}),
      ...(lastTerminalInputAtByPaneKey !== state.lastTerminalInputAtByPaneKey
        ? { lastTerminalInputAtByPaneKey }
        : {})
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
        sleepingAgentSessionsByPaneKey: { ...base, ...sleepingAgentSessionRecords }
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
