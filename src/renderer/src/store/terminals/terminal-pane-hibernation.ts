import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  restorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers
} from '@/components/terminal-pane/pty-transport'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import {
  collectHibernatedCompletionEvidenceForWorktree,
  collectSleepingAgentSessionRecordsForWorktree
} from '../slices/agent-status'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { equalStringSets, sortedUniquePtyIds } from './terminal-pty-identities'
import { resolveTerminalStopRuntimeEnvironmentId } from './terminal-workspace-routing'

export function createTerminalPaneHibernationActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'shutdownCompletedAgentPaneForHibernation'> {
  return {
    shutdownCompletedAgentPaneForHibernation: async (worktreeId, opts) => {
      const paneKeys = [opts.paneKey]
      const expectedRuntimePtyIds = sortedUniquePtyIds(
        opts.expectedRuntimePtyId ? [opts.expectedRuntimePtyId] : []
      )
      const rendererShutdownPtyIds = [opts.ptyId]
      const state = get()
      const runtimeEnvironmentId = resolveTerminalStopRuntimeEnvironmentId(state, worktreeId)
      // Why: pane transports emit renderer PTY ids, not raw exact-stop handles; guard only the identity that can deliver an exit callback.
      const exitGuardPtyIds = [opts.ptyId]
      const tab = (state.tabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === opts.tabId
      )
      const parsed = parsePaneKey(opts.paneKey)
      const layout = state.terminalLayoutsByTabId[opts.tabId]
      const liveTabPtyIds = state.ptyIdsByTabId[opts.tabId] ?? []
      if (
        !tab ||
        !parsed ||
        parsed.tabId !== opts.tabId ||
        parsed.leafId !== opts.leafId ||
        layout?.ptyIdsByLeafId?.[opts.leafId] !== opts.ptyId ||
        (expectedRuntimePtyIds.length === 0 && !liveTabPtyIds.includes(opts.ptyId))
      ) {
        throw new Error('agent_hibernation_pane_binding_mismatch')
      }
      const sleepingAgentSessionRecords = collectSleepingAgentSessionRecordsForWorktree(
        state,
        worktreeId,
        {
          paneKeys,
          captureMode: 'completed-agent-hibernation'
        }
      )
      const retainedCompletionEvidence = collectHibernatedCompletionEvidenceForWorktree(
        state,
        worktreeId,
        paneKeys
      )
      if (!sleepingAgentSessionRecords[opts.paneKey]) {
        // Why: killing the PTY with no persisted resume record strands the pane unwakeable; abort instead of hibernating unrecoverably.
        throw new Error('agent_hibernation_capture_missing')
      }
      const capture = shutdownBufferCaptures.get(opts.tabId)
      if (capture) {
        try {
          capture({ includeLocalBuffers: false })
        } catch {
          // Don't let one tab's capture failure block the pane hibernation.
        }
      }
      // Why: store sleeping records before kill, since pty:exit can arrive first.
      const sleepingRecordKeys = Object.keys(sleepingAgentSessionRecords)
      const replacedSleepingRecords: Record<string, (typeof sleepingAgentSessionRecords)[string]> =
        {}
      for (const key of sleepingRecordKeys) {
        const existing = state.sleepingAgentSessionsByPaneKey[key]
        if (existing) {
          replacedSleepingRecords[key] = existing
        }
      }
      const rollbackTargetShutdownState = (): void => {
        set((s) => {
          const next = { ...s.suppressedPtyExitIds }
          for (const ptyId of exitGuardPtyIds) {
            delete next[ptyId]
          }
          const nextSleeping = { ...s.sleepingAgentSessionsByPaneKey }
          for (const key of sleepingRecordKeys) {
            const replaced = replacedSleepingRecords[key]
            if (replaced) {
              nextSleeping[key] = replaced
            } else {
              delete nextSleeping[key]
            }
          }
          return { suppressedPtyExitIds: next, sleepingAgentSessionsByPaneKey: nextSleeping }
        })
      }
      set((s) => ({
        suppressedPtyExitIds: {
          ...s.suppressedPtyExitIds,
          ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
        },
        sleepingAgentSessionsByPaneKey: {
          ...s.sleepingAgentSessionsByPaneKey,
          ...sleepingAgentSessionRecords
        }
      }))
      if (expectedRuntimePtyIds.length > 0) {
        if (!runtimeEnvironmentId) {
          rollbackTargetShutdownState()
          throw new Error('missing_runtime_for_exact_terminal_stop')
        }
        let stopResult: {
          stoppedPtyIds?: string[]
          livePtyIds?: string[]
          postStopVerified?: boolean
          postStopFailure?: string
        }
        try {
          stopResult = await callRuntimeRpc<{
            stoppedPtyIds?: string[]
            livePtyIds?: string[]
            postStopVerified?: boolean
            postStopFailure?: string
          }>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'terminal.stopExact',
            {
              worktree: toRuntimeWorktreeSelector(worktreeId),
              expectedPtyIds: expectedRuntimePtyIds,
              keepHistory: true,
              targetOnly: true
            },
            { timeoutMs: 15000 }
          )
        } catch (err) {
          rollbackTargetShutdownState()
          throw err
        }
        const stoppedPtyIds = sortedUniquePtyIds(stopResult.stoppedPtyIds)
        const livePtyIds = sortedUniquePtyIds(stopResult.livePtyIds)
        const targetWasLive = expectedRuntimePtyIds.every((ptyId) => livePtyIds.includes(ptyId))
        if (!equalStringSets(stoppedPtyIds, expectedRuntimePtyIds) || !targetWasLive) {
          rollbackTargetShutdownState()
          throw new Error('exact_terminal_stop_mismatch')
        }
        if (stopResult.postStopVerified !== true) {
          rollbackTargetShutdownState()
          throw new Error(stopResult.postStopFailure ?? 'exact_terminal_stop_unverified')
        }
        for (const snapshot of unregisterPtyDataHandlers(rendererShutdownPtyIds) ?? []) {
          snapshot.commit?.()
        }
      } else if (!opts.ptyId.startsWith('remote:')) {
        // Why: pty.kill can flush final data before exit; unregister first so stale handlers can't fire phantom notifications during hibernation.
        const handlerSnapshots = unregisterPtyDataHandlers(rendererShutdownPtyIds) ?? []
        try {
          await window.api.pty.kill(opts.ptyId, { keepHistory: true })
        } catch (err) {
          restorePtyDataHandlersAfterFailedShutdown(handlerSnapshots)
          rollbackTargetShutdownState()
          throw err
        }
        for (const snapshot of handlerSnapshots) {
          snapshot.commit?.()
        }
      }
      set((s) => {
        const existingPtyIds = s.ptyIdsByTabId[opts.tabId] ?? []
        const shutdownPtyIdSet = new Set(rendererShutdownPtyIds)
        const remainingPtyIds = existingPtyIds.filter((ptyId) => !shutdownPtyIdSet.has(ptyId))
        const nextTabsByWorktree = { ...s.tabsByWorktree }
        const tabs = nextTabsByWorktree[worktreeId] ?? []
        const tabIndex = tabs.findIndex((candidate) => candidate.id === opts.tabId)
        if (tabIndex !== -1) {
          const nextTabs = [...tabs]
          nextTabs[tabIndex] = {
            ...nextTabs[tabIndex],
            ptyId: remainingPtyIds.at(-1) ?? null
          }
          nextTabsByWorktree[worktreeId] = nextTabs
        }
        const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
        for (const ptyId of exitGuardPtyIds) {
          delete nextCodexRestartNoticeByPtyId[ptyId]
        }
        const nextLastKnownRelay =
          remainingPtyIds.length === 0
            ? { ...s.lastKnownRelayPtyIdByTabId }
            : s.lastKnownRelayPtyIdByTabId
        if (remainingPtyIds.length === 0) {
          delete nextLastKnownRelay[opts.tabId]
        }
        let nextRuntimePaneTitlesByTabId = s.runtimePaneTitlesByTabId
        const numericPaneId = Number(opts.leafId)
        if (
          Number.isInteger(numericPaneId) &&
          s.runtimePaneTitlesByTabId[opts.tabId]?.[numericPaneId]
        ) {
          const nextByPane = { ...s.runtimePaneTitlesByTabId[opts.tabId] }
          delete nextByPane[numericPaneId]
          nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
          if (Object.keys(nextByPane).length > 0) {
            nextRuntimePaneTitlesByTabId[opts.tabId] = nextByPane
          } else {
            delete nextRuntimePaneTitlesByTabId[opts.tabId]
          }
        }
        const nextUnreadTerminalPanes = { ...s.unreadTerminalPanes }
        const nextUnreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
        const nextLastTerminalInputAtByPaneKey = { ...s.lastTerminalInputAtByPaneKey }
        delete nextUnreadTerminalPanes[opts.paneKey]
        delete nextUnreadAgentCompletionPanes[opts.paneKey]
        delete nextLastTerminalInputAtByPaneKey[opts.paneKey]
        return {
          tabsByWorktree: nextTabsByWorktree,
          ptyIdsByTabId: {
            ...s.ptyIdsByTabId,
            [opts.tabId]: remainingPtyIds
          },
          lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
          suppressedPtyExitIds: {
            ...s.suppressedPtyExitIds,
            ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
          },
          codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
          ...(nextRuntimePaneTitlesByTabId !== s.runtimePaneTitlesByTabId
            ? { runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId }
            : {}),
          unreadTerminalPanes: nextUnreadTerminalPanes,
          unreadAgentCompletionPanes: nextUnreadAgentCompletionPanes,
          lastTerminalInputAtByPaneKey: nextLastTerminalInputAtByPaneKey
        }
      })
      get().dropHibernatedAgentStatusPane(worktreeId, opts.paneKey, {
        retainedCompletionEvidence
      })
    }
  }
}
