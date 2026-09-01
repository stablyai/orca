import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { useAppStore } from '../store'
import {
  listRemoteRuntimeSessionTabsAfterCurrentInFlight,
  listRemoteRuntimeSessionTabsDeduped
} from './remote-runtime-session-tabs-inflight'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { captureRuntimeEnvironmentCall } from './web-runtime-session-environment'
import { throwIfE2eWebRuntimeBrowserReconciliationFails } from './web-runtime-browser-creation-e2e-fault'
import { recoverWebSessionTerminalOrphansBeforeApply } from './web-session-terminal-orphan-recovery'

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
  const webSessionTabsSync = await import('./web-session-tabs-sync')
  const expectedEnvironmentPairingRevision =
    options.expectedEnvironmentPairingRevision ?? getRuntimeEnvironmentRevision(environmentId)
  const expectedEnvironmentConnectionGeneration =
    getRuntimeEnvironmentConnectionGeneration(environmentId)
  const expectedTrackingGeneration =
    webSessionTabsSync.getWebSessionTabsTrackingGeneration(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(
    environmentId,
    expectedEnvironmentPairingRevision
  )
  try {
    if (options.acceptCurrentSnapshot) {
      const { acceptReplayedWebSessionTabsSnapshot } = await import('./web-session-tabs-sync')
      // Why: the host snapshot may have arrived before structured create returned;
      // re-accept its current version after the exact provisional handoff is known.
      acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
    }
    const listSessionTabs =
      options.confirmAgentSessionHandoff || options.afterCurrentInFlight
        ? listRemoteRuntimeSessionTabsAfterCurrentInFlight
        : listRemoteRuntimeSessionTabsDeduped
    if (options.afterCurrentInFlight) {
      throwIfE2eWebRuntimeBrowserReconciliationFails()
    }
    const snapshot = await listSessionTabs({
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
        return unwrapRuntimeRpcResult(
          response as RuntimeRpcResponse<RuntimeMobileSessionTabsResult>
        )
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
    const {
      applyWebSessionTabsSnapshot,
      applyWebSessionTabsStorePatch,
      decideWebSessionTabsSnapshot
    } = webSessionTabsSync
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision) {
      return
    }
    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      useAppStore.getState(),
      snapshot,
      environmentId,
      {
        expectedEnvironmentPairingRevision,
        getCurrentState: () => useAppStore.getState()
      }
    )
    if (
      !recovered ||
      getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision
    ) {
      return
    }
    // Why: this list is the host answering, but only the frame's own decision
    // says whether that answer is evidence — a workspace the mirror never
    // writes is discarded with nothing accepted behind it.
    const decision = decideWebSessionTabsSnapshot(recovered, environmentId)
    const settleMirror = applyWebSessionTabsStorePatch(
      (state) => {
        // Why: eager refreshes can resolve after the user switched worktrees; update tabs without stealing focus.
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
    // Why: host creation already succeeded; the long-lived session.tabs subscription catches up if this eager refresh fails.
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
