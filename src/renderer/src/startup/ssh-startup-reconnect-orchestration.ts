import type { SshConnectionState } from '../../../shared/ssh-types'
import {
  reconnectSshTargetsForRendererStartup,
  shouldStartBackgroundSshReconnect,
  type SshStartupReconnectBatchResult,
  type SshStartupReconnectScheduler
} from './ssh-startup-reconnect'

export type SshStartupReconnectOrchestration = {
  criticalResults: SshStartupReconnectBatchResult[]
  /** Resolves when the fire-and-forget background batch settles; null when there is none. */
  backgroundSettled: Promise<SshStartupReconnectBatchResult[]> | null
}

export type SshStartupReconnectOrchestrationArgs = {
  /** Every eager target, in the order they should be gated behind the deferred pane flow. */
  targetIds: readonly string[]
  criticalTargetIds: readonly string[]
  backgroundTargetIds: readonly string[]
  attemptTimeoutMs: number
  criticalBudgetMs: number
  signal: AbortSignal
  connect: (targetId: string) => Promise<SshConnectionState | null>
  getState: (targetId: string) => Promise<SshConnectionState | null>
  publishState: (targetId: string, state: SshConnectionState) => void
  setDeferredTargets: (targetIds: string[]) => void
  removeDeferredTarget: (targetId: string) => void
  onFailure: (targetId: string, error: unknown) => void
  /** Wraps each batch so the caller can time it as a startup step. */
  runCriticalStep: (
    run: () => Promise<SshStartupReconnectBatchResult[]>
  ) => Promise<SshStartupReconnectBatchResult[]>
  runBackgroundStep: (
    run: () => Promise<SshStartupReconnectBatchResult[]>
  ) => Promise<SshStartupReconnectBatchResult[]>
  scheduler?: SshStartupReconnectScheduler
}

// Awaits only the critical batch, then hands the caller a background batch that keeps running while
// terminal restore and the catalog refresh proceed. Deferred-target bookkeeping lives here so the
// gate a pane reads can never outlive the connection it was waiting for.
export async function startSshStartupReconnect(
  args: SshStartupReconnectOrchestrationArgs
): Promise<SshStartupReconnectOrchestration> {
  const reconnect = (
    targetIds: readonly string[],
    batchBudgetMs?: number
  ): Promise<SshStartupReconnectBatchResult[]> =>
    reconnectSshTargetsForRendererStartup({
      targetIds,
      attemptTimeoutMs: args.attemptTimeoutMs,
      batchBudgetMs,
      signal: args.signal,
      scheduler: args.scheduler,
      connect: args.connect,
      publishState: args.publishState,
      onFailure: args.onFailure
    })

  const finalizeSettledTargets = async (
    results: readonly SshStartupReconnectBatchResult[]
  ): Promise<void> => {
    // Why: the critical batch awaits this on the startup path, so probe every target at once
    // instead of paying one IPC round-trip per target serially.
    await Promise.all(
      results.map(async ({ targetId, outcome }) => {
        if (outcome === 'cancelled' || args.signal.aborted) {
          return
        }
        // Why: probe every settled outcome, not just `completed`. Main coalesces duplicate connects
        // and keeps running past our timeout, so `in-progress`/`timed-out`/`failed` targets are
        // routinely up by now — leaving them gated would strand them deferred for the process
        // lifetime, since nothing else reconciles the gate against the live connection.
        let state: SshConnectionState | null = null
        try {
          state = await args.getState(targetId)
        } catch {
          /* best-effort */
        }
        if (args.signal.aborted) {
          return
        }
        if (state?.status === 'connected') {
          args.publishState(targetId, state)
        }
        // A resolved connect is authority on its own: clear the gate even if the probe could not run.
        if (outcome === 'completed' || state?.status === 'connected') {
          args.removeDeferredTarget(targetId)
        }
      })
    )
  }

  args.setDeferredTargets([...new Set(args.targetIds)])

  const criticalResults = await args.runCriticalStep(() =>
    reconnect(args.criticalTargetIds, args.criticalBudgetMs)
  )
  await finalizeSettledTargets(criticalResults)

  if (
    !shouldStartBackgroundSshReconnect({
      backgroundTargetCount: args.backgroundTargetIds.length,
      aborted: args.signal.aborted
    })
  ) {
    return { criticalResults, backgroundSettled: null }
  }
  // No batch budget: the queue drains at the bounded concurrency until every host has had its own
  // attempt, or the startup abort signal cancels what is left.
  const backgroundSettled = args
    .runBackgroundStep(() => reconnect(args.backgroundTargetIds))
    .then(async (results) => {
      await finalizeSettledTargets(results)
      return results
    })
  return { criticalResults, backgroundSettled }
}
