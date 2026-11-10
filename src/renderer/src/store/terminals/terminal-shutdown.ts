import { stageLocalPaneSleep, type LocalPaneSleepCapture } from './terminal-sleep-capture-intent'
import type { OwnedPaneAgentRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { shutdownBufferCaptures } from '@/components/terminal-pane/snapshots/shutdown-buffer-captures'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import '../slices/agent-status/agent-status'
import { collectSleepingAgentSessionRecordsForWorktree } from '../slices/agent-status/agent-status-recovery-collection'
import type { AgentStatusWorktreeShutdownReason } from '../slices/agent-status/agent-status-contract'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { equalStringSets, sortedUniquePtyIds } from './terminal-pty-identities'
import { resolveTerminalPtyOwner } from '@/lib/terminal-worktree-route'
import { resolveTerminalTeardownOwner } from './terminal-teardown-owner'
import { createTerminalShutdownGuardController } from './terminal-shutdown-guards'
import { commitTerminalShutdownState } from './terminal-shutdown-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { recordPaneSleepThroughLayoutOwner } from './terminal-sleep-layout-owner'

type ExactTerminalStopResult = {
  stoppedPtyIds?: string[]
  livePtyIds?: string[]
  postStopVerified?: boolean
  postStopFailure?: string
}

export function createTerminalShutdownActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'shutdownWorktreeTerminals'> {
  return {
    shutdownWorktreeTerminals: async (worktreeId, opts) => {
      const keepIdentifiers = opts?.keepIdentifiers ?? false
      const shutdownReason: AgentStatusWorktreeShutdownReason =
        opts?.shutdownReason ?? (keepIdentifiers ? 'manual-sleep' : 'remove-worktree')
      const tabs = get().tabsByWorktree[worktreeId] ?? []
      const rendererShutdownPtyIds = sortedUniquePtyIds(
        tabs.flatMap((tab) => get().ptyIdsByTabId[tab.id] ?? [])
      )
      const expectedRuntimePtyIds = sortedUniquePtyIds(opts?.expectedRuntimePtyIds)
      const hostStop = opts?.hostStop
      const backendOwnsPtyTeardown = opts?.backendOwnsPtyTeardown === true || hostStop !== undefined
      const teardownOwner = resolveTerminalTeardownOwner(
        resolveTerminalPtyOwner(get(), worktreeId),
        rendererShutdownPtyIds
      )
      // Unknown owners must not lose bindings while agents run unseen and wake twins; backend-owned teardown already stopped them.
      if (teardownOwner.kind === 'refused' && !backendOwnsPtyTeardown) {
        console.warn('[terminal-shutdown] refusing teardown: terminal owner is ambiguous', {
          worktreeId,
          shutdownReason
        })
        throw new Error(teardownOwner.reason)
      }
      const runtimeEnvironmentId =
        teardownOwner.kind === 'resolved' ? teardownOwner.runtimeEnvironmentId : null
      // Only renderer-bound ids emit pane exit callbacks; raw RPC handles never enter this guard.
      const exitGuardPtyIds = rendererShutdownPtyIds
      // Main records a sleep it runs; the window takes main's records from its answer below.
      const captureSource = get()
      let sleepingAgentSessionRecords: Record<string, OwnedPaneAgentRecord> =
        keepIdentifiers && !hostStop
          ? collectSleepingAgentSessionRecordsForWorktree(captureSource, worktreeId, {
              paneKeys: opts?.sleepingPaneKeys,
              ...(shutdownReason === 'manual-sleep'
                ? { captureMode: 'manual-worktree-sleep' }
                : {}),
              ...(shutdownReason === 'auto-hibernate-completed-agent'
                ? { captureMode: 'completed-agent-hibernation' }
                : {})
            })
          : {}
      let localCapture: LocalPaneSleepCapture | undefined
      if (
        !hostStop &&
        !runtimeEnvironmentId &&
        Object.keys(sleepingAgentSessionRecords).length > 0
      ) {
        try {
          localCapture = await stageLocalPaneSleep(
            get,
            set,
            worktreeId,
            sleepingAgentSessionRecords
          )
        } catch (error) {
          if (shutdownReason === 'auto-hibernate-completed-agent') {
            throw error
          }
          console.warn('[terminal-shutdown] could not persist sleep capture before stop', error)
        }
      }
      const guards = createTerminalShutdownGuardController({
        exitGuardPtyIds,
        get,
        keepIdentifiers,
        rendererShutdownPtyIds,
        runtimeOwnsRemotePtys: runtimeEnvironmentId !== null,
        set,
        tabs,
        sleepConditionForPty: localCapture?.conditionForPty,
        guardSleepTargets:
          shutdownReason === 'manual-sleep' || shutdownReason === 'auto-hibernate-completed-agent'
      })

      // Capture before kill; capture() can publish layout changes consumed by the final commit.
      if (keepIdentifiers) {
        for (const tab of tabs) {
          const capture = shutdownBufferCaptures.get(tab.id)
          if (capture) {
            try {
              capture({ includeLocalBuffers: false })
            } catch {
              // One unavailable pane must not block capture of the rest of the worktree.
            }
          }
        }
      }

      if (expectedRuntimePtyIds.length === 0) {
        guards.markShutdownPending()
        guards.unregisterHandlers()
        try {
          opts?.onAdmitted?.()
          if (hostStop) {
            // Main stops a sleep's terminals; its answer settles the guards installed above.
            const stop = await hostStop
            if (stop.failed) {
              guards.settlePartialRendererStop([...stop.stoppedPtyIds])
              throw new Error('host_terminal_stop_failed')
            }
            sleepingAgentSessionRecords = Object.fromEntries(
              (stop.records ?? []).map((record) => [record.paneKey, record])
            )
          } else {
            if (runtimeEnvironmentId && !backendOwnsPtyTeardown) {
              // Backend ownership is opt-in; the owner RPC prevents remote PTY leaks.
              await callRuntimeRpc(
                { kind: 'environment', environmentId: runtimeEnvironmentId },
                'terminal.stop',
                { worktree: toRuntimeWorktreeSelector(worktreeId) },
                { timeoutMs: 15_000 }
              )
            }
            // Renderer teardown waits for the owner RPC so failures leave bindings retryable.
            const rendererStop = await guards.stopRendererPtys()
            if (rendererStop.failure) {
              guards.settlePartialRendererStop(rendererStop.stoppedPtyIds)
              throw rendererStop.failure.reason
            }
          }
        } catch (error) {
          if (!guards.wasPartialRendererStopSettled()) {
            guards.rollbackShutdown()
          }
          await localCapture?.settle()
          throw error
        }
      } else {
        if (!runtimeEnvironmentId) {
          throw new Error('missing_runtime_for_exact_terminal_stop')
        }
        guards.markShutdownPending()
        guards.unregisterHandlers()
        let stopResult: ExactTerminalStopResult
        try {
          stopResult = await callRuntimeRpc<ExactTerminalStopResult>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'terminal.stopExact',
            {
              worktree: toRuntimeWorktreeSelector(worktreeId),
              expectedPtyIds: expectedRuntimePtyIds,
              keepHistory: keepIdentifiers
            },
            { timeoutMs: 15_000 }
          )
        } catch (error) {
          guards.rollbackShutdown()
          await localCapture?.settle()
          throw error
        }
        const stoppedPtyIds = sortedUniquePtyIds(stopResult.stoppedPtyIds)
        const livePtyIds = sortedUniquePtyIds(stopResult.livePtyIds)
        if (
          !equalStringSets(stoppedPtyIds, expectedRuntimePtyIds) ||
          !equalStringSets(livePtyIds, expectedRuntimePtyIds)
        ) {
          guards.rollbackShutdown()
          throw new Error('exact_terminal_stop_mismatch')
        }
        if (stopResult.postStopVerified !== true) {
          guards.rollbackShutdown()
          throw new Error(stopResult.postStopFailure ?? 'exact_terminal_stop_unverified')
        }
        try {
          const rendererStop = await guards.stopRendererPtys()
          if (rendererStop.failure) {
            guards.settlePartialRendererStop(rendererStop.stoppedPtyIds)
            throw rendererStop.failure.reason
          }
        } catch (error) {
          if (!guards.wasPartialRendererStopSettled()) {
            guards.rollbackShutdown()
          }
          await localCapture?.settle()
          throw error
        }
      }

      guards.commitHandlerSnapshots()
      // Switch point: main records a sleep's resumes once the terminals stopped (none on removal).
      if (ORCA_LAYOUT_OWNER_IS_MAIN && !hostStop && runtimeEnvironmentId) {
        recordPaneSleepThroughLayoutOwner(get(), worktreeId, sleepingAgentSessionRecords)
      }
      commitTerminalShutdownState({
        exitGuardPtyIds,
        get,
        keepIdentifiers,
        set,
        shutdownReason,
        sleepingAgentSessionRecords,
        sleepAlreadyAdmitted: !hostStop && !runtimeEnvironmentId,
        ...(keepIdentifiers && !runtimeEnvironmentId && !hostStop
          ? { agentStatusAtStart: captureSource.agentStatusByPaneKey }
          : {}),
        sleepingPaneKeys: opts?.sleepingPaneKeys,
        tabs,
        worktreeId
      })
    }
  }
}
