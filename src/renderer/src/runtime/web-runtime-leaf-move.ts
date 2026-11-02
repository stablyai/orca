import type { TerminalLeafMoveRequest } from '../../../shared/terminal-leaf-move'
import { SESSION_TABS_MOVE_PANE_TO_NEW_TAB_RUNTIME_CAPABILITY } from '../../../shared/session-tabs-runtime-capabilities'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { isRecoverableRemoteRuntimeConnectionError } from '../../../shared/remote-runtime/remote-runtime-client-error-classification'
import { runtimeEnvironmentIdUnlessTwin } from '../lib/resolve-owner'
import { useAppStore } from '../store'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  captureRuntimeEnvironmentCall,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'

/** The runtime that commits this worktree's pane moves itself; null keeps the move in this window. */
export async function resolvePaneMoveHost(worktreeId: string): Promise<string | null> {
  const environmentId = runtimeEnvironmentIdUnlessTwin(
    useAppStore.getState(),
    worktreeId,
    'move a pane to a new tab on its host'
  )
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return null
  }
  const supported = await runtimeEnvironmentSupportsCapability(
    environmentId,
    SESSION_TABS_MOVE_PANE_TO_NEW_TAB_RUNTIME_CAPABILITY
  ).catch(() => false)
  return supported ? environmentId : null
}

/** The host's answer to a move; `unknown` when the reply was lost, so the host may have committed. */
export type HostPaneMoveOutcome = 'moved' | 'refused' | 'unknown'

// Why: leaf-to-tab membership is host-authoritative for remote tabs; a local-only move reverts on the next snapshot.
export async function moveWebRuntimeLeafToNewTab(
  environmentId: string,
  request: TerminalLeafMoveRequest,
  /** The drop's group and position as the host names them; an older host ignores them and appends. */
  placement: { targetGroupId: string; index?: number }
): Promise<HostPaneMoveOutcome> {
  let response: Awaited<ReturnType<ReturnType<typeof captureRuntimeEnvironmentCall>>>
  try {
    response = await captureRuntimeEnvironmentCall(environmentId)({
      method: 'session.tabs.movePaneToNewTab',
      params: {
        worktree: toRuntimeWorktreeSelector(request.worktreeId),
        sourceTabId: toHostSessionTabId(request.sourceTabId),
        targetTabId: toHostSessionTabId(request.targetTabId),
        leafId: request.leafId,
        ...placement
      },
      timeoutMs: 15_000
    })
  } catch (error) {
    console.warn(
      '[web-runtime-session] no answer to the pane move:',
      error instanceof Error ? error.message : String(error)
    )
    return 'unknown'
  }
  // Why: the bridge answers a lost transport as an error envelope, not a throw; the host may have committed.
  if (!response.ok && isRecoverableRemoteRuntimeConnectionError(response.error)) {
    console.warn('[web-runtime-session] no answer to the pane move:', response.error.code)
    return 'unknown'
  }
  const answer = response.ok ? response.result : response
  if (
    typeof answer === 'object' &&
    answer !== null &&
    'status' in answer &&
    answer.status === 'moved'
  ) {
    return 'moved'
  }
  console.warn('[web-runtime-session] host did not move the pane', answer)
  return 'refused'
}

/** Whether the host holds the moved pane in its new tab; null when the host cannot be asked. */
async function hostHoldsMovedPane(
  environmentId: string,
  request: TerminalLeafMoveRequest
): Promise<boolean | null> {
  try {
    const listed: unknown = unwrapRuntimeRpcResult(
      await captureRuntimeEnvironmentCall(environmentId)({
        method: 'session.tabs.list',
        params: { worktree: toRuntimeWorktreeSelector(request.worktreeId) },
        timeoutMs: 15_000
      })
    )
    const hostTargetTabId = toHostSessionTabId(request.targetTabId)
    const tabs =
      typeof listed === 'object' &&
      listed !== null &&
      'tabs' in listed &&
      Array.isArray(listed.tabs)
        ? listed.tabs
        : []
    return tabs.some(
      (tab: unknown) =>
        typeof tab === 'object' &&
        tab !== null &&
        'parentTabId' in tab &&
        'leafId' in tab &&
        tab.parentTabId === hostTargetTabId &&
        tab.leafId === request.leafId
    )
  } catch {
    return null
  }
}

/**
 * Settles this window with the host's answer. A committed move this window could not draw, and a
 * lost reply the host turns out to have committed, take the host's tabs; a refusal undoes the move.
 * A lost reply the host cannot be asked about waits for its next snapshot.
 */
export async function settleHostPaneMove(
  environmentId: string,
  request: TerminalLeafMoveRequest,
  outcome: HostPaneMoveOutcome,
  /** This window moved the pane before the answer. */
  movedHere: boolean
): Promise<void> {
  const committed =
    outcome === 'unknown' ? await hostHoldsMovedPane(environmentId, request) : outcome === 'moved'
  if (committed === null || (committed && movedHere)) {
    return
  }
  if (!committed && movedHere) {
    await revertRefusedPaneMove(environmentId, request)
    return
  }
  await refreshWebRuntimeSessionTabsSnapshot(environmentId, request.worktreeId, {
    acceptCurrentSnapshot: true
  })
}

/**
 * Undoes this window's move after the host kept the pane: the pane's records go back to the source,
 * the tab the window drew goes without stopping its terminal, and the host's tabs are redrawn even
 * when the host's answer is unchanged.
 */
async function revertRefusedPaneMove(
  environmentId: string,
  request: TerminalLeafMoveRequest
): Promise<void> {
  const state = useAppStore.getState()
  // The move carried the pane's status and launch records to the new tab; they come back first.
  state.transferAgentPaneAuthority({
    fromPaneKey: makePaneKey(request.targetTabId, request.leafId),
    toPaneKey: makePaneKey(request.sourceTabId, request.leafId),
    ptyId: request.ptyId
  })
  state.closeTab(request.targetTabId, {
    reason: 'cleanup',
    recordInteraction: false,
    captureRecentlyClosed: false,
    remoteCloseOwnedByHost: true,
    localPtyTeardownOwnedExternally: true
  })
  await refreshWebRuntimeSessionTabsSnapshot(environmentId, request.worktreeId, {
    acceptCurrentSnapshot: true
  })
}
