import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { requestRemoteWorktreeSleep } from '@/runtime/remote-worktree-sleep'
import {
  collectHibernatedCompletionEvidenceForWorktree,
  collectSleepingAgentSessionRecordsForWorktree,
  type AgentStatusWorktreeShutdownReason
} from '../slices/agent-status'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { equalStringSets, sortedUniquePtyIds } from './terminal-pty-identities'
import { resolveTerminalStopRuntimeEnvironmentId } from './terminal-workspace-routing'
import { createTerminalShutdownGuardController } from './terminal-shutdown-guards'
import { commitTerminalShutdownState } from './terminal-shutdown-state'

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
      const runtimeEnvironmentId = resolveTerminalStopRuntimeEnvironmentId(get(), worktreeId)
      // Only renderer-bound ids emit pane exit callbacks; raw RPC handles never enter this guard.
      const exitGuardPtyIds = rendererShutdownPtyIds
      const sleepingAgentSessionRecords = keepIdentifiers
        ? collectSleepingAgentSessionRecordsForWorktree(get(), worktreeId, {
            paneKeys: opts?.sleepingPaneKeys,
            ...(shutdownReason === 'manual-sleep' ? { captureMode: 'manual-worktree-sleep' } : {}),
            ...(shutdownReason === 'auto-hibernate-completed-agent'
              ? { captureMode: 'completed-agent-hibernation' }
              : {})
          })
        : {}
      const retainedCompletionEvidence =
        shutdownReason === 'auto-hibernate-completed-agent'
          ? collectHibernatedCompletionEvidenceForWorktree(
              get(),
              worktreeId,
              opts?.sleepingPaneKeys
            )
          : []
      const guards = createTerminalShutdownGuardController({
        exitGuardPtyIds,
        get,
        keepIdentifiers,
        rendererShutdownPtyIds,
        runtimeEnvironmentId,
        set,
        tabs
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
          // Backend ownership is opt-in; the default owner RPC prevents remote PTY leaks.
          if (runtimeEnvironmentId && opts?.backendOwnsPtyTeardown !== true) {
            await (shutdownReason === 'manual-sleep'
              ? requestRemoteWorktreeSleep({ environmentId: runtimeEnvironmentId, worktreeId })
              : callRuntimeRpc(
                  { kind: 'environment', environmentId: runtimeEnvironmentId },
                  'terminal.stop',
                  { worktree: toRuntimeWorktreeSelector(worktreeId) },
                  { timeoutMs: 15_000 }
                ))
          }
          // Renderer teardown waits for the owner RPC so failures leave bindings retryable.
          const rendererStop = await guards.stopRendererPtys()
          if (rendererStop.failure) {
            guards.settlePartialRendererStop(rendererStop.stoppedPtyIds)
            throw rendererStop.failure.reason
          }
        } catch (error) {
          if (!guards.wasPartialRendererStopSettled()) {
            guards.rollbackShutdown()
          }
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
          throw error
        }
      }

      guards.commitHandlerSnapshots()
      commitTerminalShutdownState({
        exitGuardPtyIds,
        get,
        keepIdentifiers,
        retainedCompletionEvidence,
        set,
        shutdownReason,
        sleepingAgentSessionRecords,
        sleepingPaneKeys: opts?.sleepingPaneKeys,
        tabs,
        worktreeId
      })
    }
  }
}
