import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { useAppStore } from '../store'
import {
  listRemoteRuntimeSessionTabsAfterCurrentInFlight,
  listRemoteRuntimeSessionTabsDeduped
} from './remote-runtime-session-tabs-inflight'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { captureRuntimeEnvironmentCall } from './web-runtime-session-environment'
import { throwIfE2eWebRuntimeBrowserReconciliationFails } from './web-runtime-browser-creation-e2e-fault'
import { getSessionTabsRuntimeIdFromResponse } from './web-session-tabs-sync/publisher-identity-fences'
import { WEB_SESSION_TABS_FRAME_OUTRANKED } from './web-session-tabs-sync/tracking-decisions'
// Static import is required: receipt ordering gates this path and cannot be omitted by a caller’s module mock.
import {
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-sync/tracking'
import { recoverMirroredTerminalOrphansBeforeApply } from './web-session-tabs-sync/mirror-terminal-orphan-recovery'

const pendingRuntimeWorktreeRecoveryRefreshes = new Map<string, symbol>()
const RUNTIME_WORKTREE_RECOVERY_REFRESH_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const

export async function refreshWebRuntimeSessionTabsSnapshot(
  environmentId: string,
  worktreeId: string,
  options: {
    expectedEnvironmentPairingRevision?: number
    acceptCurrentSnapshot?: boolean
    confirmAgentSessionHandoff?: {
      provisionalTabId: string
      hostTabId: string
      hostTerminalHandle: string
    }
    afterCurrentInFlight?: boolean
    errorMode?: 'warn' | 'throw'
  } = {}
): Promise<void> {
  // Await up front; list application and its receipt must not yield between them.
  const [
    { applyWebSessionTabsSnapshot },
    { applyWebSessionTabsStorePatch },
    { decideWebSessionTabsSnapshot },
    { getWebSessionTabsTrackingGeneration }
  ] = await Promise.all([
    import('./web-session-tabs-sync/snapshot-api'),
    import('./web-session-tabs-sync/store-patch'),
    import('./web-session-tabs-sync/tracking-decisions'),
    import('./web-session-tabs-sync/tracking-lifecycle')
  ])
  const expectedEnvironmentPairingRevision =
    options.expectedEnvironmentPairingRevision ?? getRuntimeEnvironmentRevision(environmentId)
  const expectedEnvironmentConnectionGeneration =
    getRuntimeEnvironmentConnectionGeneration(environmentId)
  const expectedTrackingGeneration = getWebSessionTabsTrackingGeneration(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(
    environmentId,
    expectedEnvironmentPairingRevision
  )
  try {
    if (options.acceptCurrentSnapshot) {
      const { acceptReplayedWebSessionTabsSnapshot } =
        await import('./web-session-tabs-sync/tracking-lifecycle')
      // Publication can beat structured create; reaccept its version after the exact provisional handoff is known.
      acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
    }
    const listSessionTabs =
      options.confirmAgentSessionHandoff || options.afterCurrentInFlight
        ? listRemoteRuntimeSessionTabsAfterCurrentInFlight
        : listRemoteRuntimeSessionTabsDeduped
    if (options.afterCurrentInFlight) {
      throwIfE2eWebRuntimeBrowserReconciliationFails()
    }
    const { snapshot, receivedFrame, runtimeId } = await listSessionTabs({
      environmentId,
      worktreeId,
      load: async () => {
        const response = await callEnvironment({
          method: 'session.tabs.list',
          params: {
            worktree: toRuntimeWorktreeSelector(worktreeId)
          },
          timeoutMs: 15_000
        })
        return {
          snapshot: unwrapRuntimeRpcResult(
            response as RuntimeRpcResponse<RuntimeMobileSessionTabsResult>
          ),
          runtimeId: getSessionTabsRuntimeIdFromResponse(response)
        }
      }
    })
    if (options.confirmAgentSessionHandoff) {
      const { confirmWebAgentSessionHandoffAfterCreate } =
        await import('./web-agent-session-handoff')
      // Why: this list completed after structured creation, so absence now proves the exact host tab already retired.
      confirmWebAgentSessionHandoffAfterCreate({
        environmentId,
        worktreeId,
        ...options.confirmAgentSessionHandoff
      })
    }
    // Reserve receipt order before ranking; a list answered before close can arrive after retraction.
    recordReceivedWebSessionTabsSnapshot(
      environmentId,
      snapshot,
      receivedFrame,
      runtimeId,
      'bootstrap'
    )
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision) {
      return
    }
    const recovered = await recoverMirroredTerminalOrphansBeforeApply(
      useAppStore.getState(),
      snapshot,
      environmentId,
      {
        expectedEnvironmentPairingRevision,
        expectedRuntimeId: runtimeId,
        getCurrentState: () => useAppStore.getState()
      }
    )
    if (
      !recovered ||
      getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision
    ) {
      return
    }
    // Only the frame decision proves this host answer was accepted; discarded workspaces supply no evidence.
    const decision = shouldApplyRecoveredWebSessionTabsSnapshot(
      environmentId,
      recovered,
      receivedFrame,
      runtimeId
    )
      ? decideWebSessionTabsSnapshot(recovered, environmentId)
      : WEB_SESSION_TABS_FRAME_OUTRANKED
    const settleMirror = applyWebSessionTabsStorePatch(
      (state) => {
        // Eager refresh can outlive workspace switches; update tabs without taking focus.
        const patch = decision.apply
          ? applyWebSessionTabsSnapshot(state, recovered, environmentId)
          : state
        return patch === state ? state : patch
      },
      {
        frames: [
          {
            environmentId,
            worktreeId: snapshot.worktree,
            source: recovered,
            decision,
            expectedEnvironmentConnectionGeneration,
            expectedEnvironmentPairingRevision,
            expectedTrackingGeneration
          }
        ]
      },
      recovered
    )
    settleMirror()
  } catch (error) {
    if (options.errorMode === 'throw') {
      throw error
    }
    // Creation succeeded; the long-lived subscription catches up after eager-refresh failure.
    console.warn(
      '[web-runtime-session] failed to refresh session-tabs snapshot:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function scheduleRuntimeWorktreeRecoveryRefresh(
  environmentId: string,
  worktreeId: string,
  expectedEnvironmentPairingRevision = getRuntimeEnvironmentRevision(environmentId)
): void {
  const initialState = useAppStore.getState()
  if (!('tabsByWorktree' in initialState)) {
    return
  }
  if ((initialState.tabsByWorktree[worktreeId] ?? []).length > 0) {
    return
  }
  const key = `${environmentId}\0${expectedEnvironmentPairingRevision ?? ''}\0${worktreeId}`
  const token = Symbol(key)
  pendingRuntimeWorktreeRecoveryRefreshes.set(key, token)
  void (async () => {
    try {
      for (const delayMs of RUNTIME_WORKTREE_RECOVERY_REFRESH_DELAYS_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        if (pendingRuntimeWorktreeRecoveryRefreshes.get(key) !== token) {
          return
        }
        if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision) {
          return
        }
        await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, {
          expectedEnvironmentPairingRevision
        })
        if ((useAppStore.getState().tabsByWorktree[worktreeId] ?? []).length > 0) {
          return
        }
      }
    } finally {
      if (pendingRuntimeWorktreeRecoveryRefreshes.get(key) === token) {
        pendingRuntimeWorktreeRecoveryRefreshes.delete(key)
      }
    }
  })()
}
