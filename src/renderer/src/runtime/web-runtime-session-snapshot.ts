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
import { getSessionTabsRuntimeIdFromResponse } from './web-session-tabs-sync/publisher-identity-fences'
import { WEB_SESSION_TABS_FRAME_OUTRANKED } from './web-session-tabs-sync/tracking-decisions'
// Not through the barrel: receipt ordering is this path's gate, not an optional collaborator a
// caller's module mock may leave out — doing so is what left this path unordered to begin with.
import {
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-sync/tracking'
import { recoverWebSessionTerminalOrphansBeforeApply } from './web-session-terminal-orphan-recovery'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import { worktreeSelectionOwnerKey } from '@/lib/worktree-selection-owner'
import {
  admitsWebRuntimeSessionWorktreeSnapshot,
  isCurrentWebRuntimeSessionWorktreeOwner
} from './web-runtime-session-worktree-owner'

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
    owner?: WorktreeSelectionOwner
  } = {}
): Promise<void> {
  const webSessionTabsSync = await import('./web-session-tabs-sync')
  if (
    options.owner &&
    (!options.owner.instanceId ||
      !isCurrentWebRuntimeSessionWorktreeOwner(
        useAppStore.getState(),
        environmentId,
        options.owner
      ))
  ) {
    return
  }
  const worktreeSelector = toRuntimeWorktreeSelector(
    worktreeId,
    options.owner?.instanceId
      ? { executionHostId: options.owner.executionHostId, instanceId: options.owner.instanceId }
      : undefined
  )
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
      worktreeSelector,
      load: async () => {
        const response = await callEnvironment({
          method: 'session.tabs.list',
          params: {
            worktree: worktreeSelector
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
    if (
      !admitsWebRuntimeSessionWorktreeSnapshot(
        useAppStore.getState(),
        environmentId,
        snapshot,
        options.owner
      )
    ) {
      if (options.errorMode === 'throw') {
        throw new Error('selector_not_found')
      }
      return
    }
    if (options.acceptCurrentSnapshot) {
      const { acceptReplayedWebSessionTabsSnapshot } = await import('./web-session-tabs-sync')
      // Why: re-accept a host answer only after its exact owner is admitted.
      acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
    }
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
    // A list is evidence about a moment, not about now. Record its place in receipt order before
    // ranking it, or a snapshot the host answered before a close lands after the retraction did.
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
    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
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
      !admitsWebRuntimeSessionWorktreeSnapshot(
        useAppStore.getState(),
        environmentId,
        recovered,
        options.owner
      ) ||
      getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision
    ) {
      return
    }
    // Why: this list is the host answering, but only the frame's own decision
    // says whether that answer is evidence — a workspace the mirror never
    // writes is discarded with nothing accepted behind it.
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
        if (
          !admitsWebRuntimeSessionWorktreeSnapshot(state, environmentId, recovered, options.owner)
        ) {
          return state
        }
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
  expectedEnvironmentPairingRevision = getRuntimeEnvironmentRevision(environmentId),
  owner?: WorktreeSelectionOwner
): void {
  const initialState = useAppStore.getState()
  if (!('tabsByWorktree' in initialState)) {
    return
  }
  if ((initialState.tabsByWorktree[worktreeId] ?? []).length > 0) {
    return
  }
  const key = `${environmentId}\0${expectedEnvironmentPairingRevision ?? ''}\0${worktreeId}\0${worktreeSelectionOwnerKey(owner)}`
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
        if (
          owner &&
          !isCurrentWebRuntimeSessionWorktreeOwner(useAppStore.getState(), environmentId, owner)
        ) {
          return
        }
        await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, {
          expectedEnvironmentPairingRevision,
          ...(owner ? { owner } : {})
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
