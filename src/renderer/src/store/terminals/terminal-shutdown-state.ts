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
    const ptyIdsByTabId = {
      ...state.ptyIdsByTabId,
      ...Object.fromEntries(tabs.map((tab) => [tab.id, [] as string[]] as const))
    }
    const runtimePaneTitlesByTabId = keepIdentifiers
      ? state.runtimePaneTitlesByTabId
      : { ...state.runtimePaneTitlesByTabId }
    const suppressedPtyExitIds = {
      ...state.suppressedPtyExitIds,
      ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
    }
    const pendingPtyShutdownIds = { ...state.pendingPtyShutdownIds }
    for (const ptyId of exitGuardPtyIds) {
      const remainingOwners = (pendingPtyShutdownIds[ptyId] ?? 0) - 1
      if (remainingOwners > 0) {
        pendingPtyShutdownIds[ptyId] = remainingOwners
      } else {
        delete pendingPtyShutdownIds[ptyId]
      }
    }

    // Sleeping terminals retain restart intent, but a wake can receive a different live PTY id.
    const pendingCodexPaneRestartIds = keepIdentifiers
      ? state.pendingCodexPaneRestartIds
      : { ...state.pendingCodexPaneRestartIds }
    const codexRestartNoticeByPtyId = { ...state.codexRestartNoticeByPtyId }
    for (const ptyId of exitGuardPtyIds) {
      if (!keepIdentifiers) {
        delete pendingCodexPaneRestartIds[ptyId]
      }
      delete codexRestartNoticeByPtyId[ptyId]
    }

    const pendingSetupSplitByTabId = { ...state.pendingSetupSplitByTabId }
    const pendingIssueCommandSplitByTabId = { ...state.pendingIssueCommandSplitByTabId }
    const terminalLayoutsByTabId = { ...state.terminalLayoutsByTabId }
    let unreadTerminalTabs = state.unreadTerminalTabs
    let unreadTerminalPanes = state.unreadTerminalPanes
    let unreadAgentCompletionPanes = state.unreadAgentCompletionPanes
    let lastTerminalInputAtByPaneKey = state.lastTerminalInputAtByPaneKey

    for (const tab of tabs) {
      if (!keepIdentifiers) {
        delete runtimePaneTitlesByTabId[tab.id]
      }
      delete pendingSetupSplitByTabId[tab.id]
      delete pendingIssueCommandSplitByTabId[tab.id]
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
        if (layout?.ptyIdsByLeafId) {
          terminalLayoutsByTabId[tab.id] = { ...layout, ptyIdsByLeafId: {} }
        }
      }
    }

    const lastKnownRelayPtyIdByTabId = keepIdentifiers
      ? state.lastKnownRelayPtyIdByTabId
      : { ...state.lastKnownRelayPtyIdByTabId }
    if (!keepIdentifiers) {
      for (const tab of tabs) {
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
