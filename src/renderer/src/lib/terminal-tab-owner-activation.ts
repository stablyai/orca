import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { activateWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'
import { browserWorkspaceHasRemoteOwner } from '@/runtime/remote-browser-tab-ownership'

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
    expectedPairingRevision,
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
