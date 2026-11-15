import { replaceRecordEntries, replaceTabBuckets } from '@/store/keyed-record-transitions'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import '@/components/terminal-pane/pty-transport/delivery/pty-dispatcher'
import {
  restorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers
} from '@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension'
import { shutdownBufferCaptures } from '@/components/terminal-pane/snapshots/shutdown-buffer-captures'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import '../../slices/agent-status/agent-status'
import { collectSleepingAgentSessionRecordsForWorktree } from '../../slices/agent-status/agent-status-recovery-collection'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from '../terminal-state'
import { equalStringSets, sortedUniquePtyIds } from '../pty/terminal-pty-identities'
import { resolveTerminalPtyOwner } from '@/lib/workspace/ownership/terminal-worktree-route'
import { resolveTerminalTeardownOwner } from './terminal-teardown-owner'
import { settleAttentionRemovedBy } from '../../slices/workspace-attention/attention-removal-follow-up'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { recordPaneSleepThroughLayoutOwner } from './terminal-sleep-layout-owner'

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
      const worktreeOwner = resolveTerminalPtyOwner(state, worktreeId)
      const teardownOwner = resolveTerminalTeardownOwner(worktreeOwner, [opts.ptyId])
      // Use PTY owner for twins; losing bindings without an attributable host stop leaves unseen running agents.
      if (
        teardownOwner.kind === 'refused' ||
        (worktreeOwner.kind === 'ambiguous' &&
          isRemoteRuntimePtyId(opts.ptyId) &&
          expectedRuntimePtyIds.length === 0)
      ) {
        console.warn('[agent-hibernation] refusing pane hibernation: terminal owner is ambiguous', {
          worktreeId,
          paneKey: opts.paneKey
        })
        throw new Error('ambiguous_terminal_owner')
      }
      const runtimeEnvironmentId = teardownOwner.runtimeEnvironmentId
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
      if (!sleepingAgentSessionRecords[opts.paneKey]) {
        // Killing without a persisted resume record would strand the pane.
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
          return {
            suppressedPtyExitIds: next,
            sleepingAgentSessionsByPaneKey: replaceRecordEntries(
              s.sleepingAgentSessionsByPaneKey,
              sleepingRecordKeys.map((key) => [key, replacedSleepingRecords[key] ?? null] as const)
            )
          }
        })
      }
      set((s) => ({
        suppressedPtyExitIds: {
          ...s.suppressedPtyExitIds,
          ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
        },
        sleepingAgentSessionsByPaneKey: replaceRecordEntries(
          s.sleepingAgentSessionsByPaneKey,
          Object.entries(sleepingAgentSessionRecords)
        )
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
      } else if (!isRemoteRuntimePtyId(opts.ptyId)) {
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
      // Switch point: main records the sleep this window decided, once the stop settled.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        recordPaneSleepThroughLayoutOwner(get(), worktreeId, sleepingAgentSessionRecords)
      }
      settleAttentionRemovedBy(set, get, () =>
        set((s) => {
          const existingPtyIds = s.ptyIdsByTabId[opts.tabId] ?? []
          const shutdownPtyIdSet = new Set(rendererShutdownPtyIds)
          const remainingPtyIds = existingPtyIds.filter((ptyId) => !shutdownPtyIdSet.has(ptyId))
          const tabs = s.tabsByWorktree[worktreeId] ?? []
          const replacements: [string, typeof tabs][] = []
          const tabIndex = tabs.findIndex((candidate) => candidate.id === opts.tabId)
          if (tabIndex !== -1) {
            const nextTabs = [...tabs]
            nextTabs[tabIndex] = {
              ...nextTabs[tabIndex],
              ptyId: remainingPtyIds.at(-1) ?? null
            }
            replacements.push([worktreeId, nextTabs])
          }
          const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
          for (const ptyId of exitGuardPtyIds) {
            delete nextCodexRestartNoticeByPtyId[ptyId]
          }
          const nextLastKnownRelay =
            remainingPtyIds.length === 0
              ? replaceRecordEntries<string>(s.lastKnownRelayPtyIdByTabId, [[opts.tabId, null]])
              : s.lastKnownRelayPtyIdByTabId
          let nextRuntimePaneTitlesByTabId = s.runtimePaneTitlesByTabId
          const numericPaneId = Number(opts.leafId)
          if (
            Number.isInteger(numericPaneId) &&
            s.runtimePaneTitlesByTabId[opts.tabId]?.[numericPaneId]
          ) {
            const nextByPane = { ...s.runtimePaneTitlesByTabId[opts.tabId] }
            delete nextByPane[numericPaneId]
            nextRuntimePaneTitlesByTabId = replaceRecordEntries(s.runtimePaneTitlesByTabId, [
              [opts.tabId, Object.keys(nextByPane).length > 0 ? nextByPane : null]
            ])
          }
          const nextLastTerminalInputAtByPaneKey = { ...s.lastTerminalInputAtByPaneKey }
          delete nextLastTerminalInputAtByPaneKey[opts.paneKey]
          return {
            tabsByWorktree: replaceTabBuckets(s.tabsByWorktree, replacements),
            ptyIdsByTabId: replaceRecordEntries(s.ptyIdsByTabId, [[opts.tabId, remainingPtyIds]]),
            lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
            suppressedPtyExitIds: {
              ...s.suppressedPtyExitIds,
              ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
            },
            codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
            ...(nextRuntimePaneTitlesByTabId !== s.runtimePaneTitlesByTabId
              ? {
                  runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId
                }
              : {}),
            lastTerminalInputAtByPaneKey: nextLastTerminalInputAtByPaneKey
          }
        })
      )
      get().dropHibernatedAgentStatusPane(worktreeId, opts.paneKey)
    }
  }
}
