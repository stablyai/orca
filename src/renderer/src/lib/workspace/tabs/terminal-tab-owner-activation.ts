import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { activateWebRuntimeSessionTab } from '@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle'
import {
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import { browserWorkspaceHasRemoteOwner } from '@/runtime/browser/ownership/remote-browser-tab-ownership'
import { resolveOwnerOrLocal } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { getPtyExecutionHost } from '../../../../../shared/terminal/pty/lifecycle/terminal-execution-host'
import {
  getConnectionExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { isExecutionHostForWorktree } from '../ownership/qualified-worktree-execution-owner'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AppState } from '@/store/types'

/** A host-published row can precede its mirrored tab, but retained local status cannot wake one. */
export function resolveUnmirroredAgentTerminalOwner(
  state: AppState,
  worktreeId: string,
  entry: AgentStatusEntry,
  cardHostId?: ExecutionHostId
): string | null {
  const owner = resolveOwnerOrLocal(state, { workspaceId: worktreeId, hostId: cardHostId })
  if (owner.kind !== 'resolved' || owner.owner.endpoint.kind !== 'environment') {
    return null
  }
  const { environmentId } = owner.owner.endpoint
  if (
    state.removedRuntimeEnvironmentIds.has(environmentId) ||
    !state.runtimeEnvironments.some((environment) => environment.id === environmentId)
  ) {
    return null
  }
  const statusHost = getPtyExecutionHost(entry.terminalHandle)
  return statusHost === toRuntimeExecutionHostId(environmentId) ||
    (!statusHost && entry.connectionId === environmentId) ||
    (cardHostId &&
      (statusHost || entry.connectionId) &&
      isExecutionHostForWorktree(
        state,
        worktreeId,
        cardHostId,
        statusHost ?? getConnectionExecutionHostId(entry.connectionId)
      ))
    ? environmentId
    : null
}

/** After local activation, notify the paired owner to store this client’s selection and wake parked panes. Focus late-arriving tabs unless navigation changed meanwhile. Local/direct-SSH workspaces need no owner round trip. */
export function activateTerminalTabOnOwner(
  worktreeId: string,
  tabId: string,
  leafId: string | null,
  ownerEnvironmentId?: string | null,
  expectedPairingRevision?: number
): void {
  const state = useAppStore.getState()
  const environmentId =
    ownerEnvironmentId === undefined
      ? runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
      : ownerEnvironmentId
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return
  }
  void activateWebRuntimeSessionTab({
    worktreeId,
    tabId,
    environmentId,
    leafId,
    // Bind to the pairing at the gesture: activation awaits a lazy import before its RPC.
    expectedPairingRevision:
      expectedPairingRevision ?? captureWebSessionIntentOwner(environmentId).pairingRevision,
    expectedCurrentLocalTabId: resolveWebSessionVisibleTabId(state, worktreeId)
  })
}

/** A browser tab the owner hosts; its selection must follow local activation like a terminal's. */
export function activateBrowserTabOnOwner(
  worktreeId: string,
  unifiedTabId: string,
  browserWorkspaceId: string
): void {
  const state = useAppStore.getState()
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  if (
    !environmentId ||
    !isWebRuntimeSessionActive(environmentId) ||
    !browserWorkspaceHasRemoteOwner(state, browserWorkspaceId, environmentId)
  ) {
    return
  }
  void activateWebRuntimeSessionTab({
    worktreeId,
    tabId: unifiedTabId,
    environmentId,
    // Later local navigation cancels this deferred focus, as for terminals.
    expectedCurrentLocalTabId: resolveWebSessionVisibleTabId(state, worktreeId)
  })
}
