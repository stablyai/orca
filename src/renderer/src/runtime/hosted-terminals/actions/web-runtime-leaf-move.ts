import type { TerminalLeafMoveRequest } from '../../../../../shared/workspace-layout/terminal-topology/terminal-leaf-move'
import { SESSION_TABS_MOVE_PANE_TO_NEW_TAB_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import { toHostSessionTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { isRecoverableRemoteRuntimeConnectionError } from '../../../../../shared/remote-runtime/remote-runtime-client-error-classification'
import { runtimeEnvironmentIdUnlessTwin } from '../../../lib/workspace/ownership/resolve-owner'
import { useAppStore } from '../../../store/index'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import { unwrapRuntimeRpcResult } from '../../rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import {
  captureRuntimeEnvironmentCall,
  isWebRuntimeSessionActive
} from '../../web-session-tabs-sync/identity/web-runtime-session-environment'
import { refreshWebRuntimeSessionTabsSnapshot } from '../../web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import { getRuntimeEnvironmentRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import { focusTerminalTabSurface } from '../../../components/terminal-pane/input/focus/focus-terminal-tab-surface'

/**
 * Who commits a pane move for this worktree: its paired host, this window (local, direct SSH and
 * twins), or nobody, when a host owns the tabs but cannot take the move now (no live session, or
 * an older host without the capability), so a window-only move would be undone by its next snapshot.
 */
export type PaneMoveHostRoute =
  | { kind: 'host'; authority: PaneMoveHostAuthority }
  | { kind: 'window' }
  | { kind: 'unavailable' }

/**
 * The host pairing admitted for one move. Every call and every local effect of that move uses it:
 * after a re-pair, the replacement host's snapshots decide, and nothing from the old move applies.
 */
export type PaneMoveHostAuthority = { environmentId: string; pairingRevision: number | undefined }

export function isCurrentPairing(authority: PaneMoveHostAuthority): boolean {
  return getRuntimeEnvironmentRevision(authority.environmentId) === authority.pairingRevision
}

function callHost(authority: PaneMoveHostAuthority) {
  return captureRuntimeEnvironmentCall(authority.environmentId, authority.pairingRevision)
}

function refreshFromHost(authority: PaneMoveHostAuthority, worktreeId: string): Promise<void> {
  return refreshWebRuntimeSessionTabsSnapshot(authority.environmentId, worktreeId, {
    acceptCurrentSnapshot: true,
    expectedEnvironmentPairingRevision: authority.pairingRevision
  })
}

export async function resolvePaneMoveHost(worktreeId: string): Promise<PaneMoveHostRoute> {
  const environmentId = runtimeEnvironmentIdUnlessTwin(
    useAppStore.getState(),
    worktreeId,
    'move a pane to a new tab on its host'
  )
  if (!environmentId) {
    return { kind: 'window' }
  }
  if (!isWebRuntimeSessionActive(environmentId)) {
    return { kind: 'unavailable' }
  }
  const authority = { environmentId, pairingRevision: getRuntimeEnvironmentRevision(environmentId) }
  const supported = await runtimeEnvironmentSupportsCapability(
    environmentId,
    SESSION_TABS_MOVE_PANE_TO_NEW_TAB_RUNTIME_CAPABILITY
  ).catch(() => false)
  // The capability proof belongs to the pairing it was asked of.
  return supported && isCurrentPairing(authority)
    ? { kind: 'host', authority }
    : { kind: 'unavailable' }
}

/** The host's answer to a move; `unknown` when the reply was lost, so the host may have committed. */
export type HostPaneMoveOutcome = 'moved' | 'refused' | 'unknown'

// Why: leaf-to-tab membership is host-authoritative for remote tabs; a local-only move reverts on the next snapshot.
export async function moveWebRuntimeLeafToNewTab(
  authority: PaneMoveHostAuthority,
  request: TerminalLeafMoveRequest,
  /** The drop's group and position as the host names them; an older host ignores them and appends. */
  placement: { targetGroupId: string; index?: number }
): Promise<HostPaneMoveOutcome> {
  let response: Awaited<ReturnType<ReturnType<typeof captureRuntimeEnvironmentCall>>>
  try {
    response = await callHost(authority)({
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
  authority: PaneMoveHostAuthority,
  request: TerminalLeafMoveRequest
): Promise<boolean | null> {
  try {
    const listed: unknown = unwrapRuntimeRpcResult(
      await callHost(authority)({
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

export type HostPaneMoveSettleHooks = {
  /** Tells the user the host refused their move; absent for a move another client asked for. */
  onRefused?: () => void
  /** The host holds the pane in the tab this window drew. */
  onCommitted?: () => void
}

/** A lost reply is asked about once more after this long; after that the host's snapshots decide. */
const LOST_REPLY_RECHECK_MS = 5_000

/**
 * Settles this window with the host's answer. The host's versioned tab snapshots are the only
 * truth; this only decides what the window does until the next one lands (keyed by the move's
 * fresh target tab id and leaf). A committed move this window could not draw, and a lost reply
 * the host turns out to have committed, take the host's tabs; a refusal undoes the move. Only an
 * explicit refusal is reported: after a lost reply a late commit can still arrive, so a lost
 * reply is checked once more later (bounded), and a commit found then is drawn and named.
 */
export async function settleHostPaneMove(
  authority: PaneMoveHostAuthority,
  request: TerminalLeafMoveRequest,
  outcome: HostPaneMoveOutcome,
  /** This window moved the pane before the answer. */
  movedHere: boolean,
  hooks: HostPaneMoveSettleHooks = {},
  recheckDelayMs = LOST_REPLY_RECHECK_MS
): Promise<void> {
  const committed =
    outcome === 'unknown' ? await hostHoldsMovedPane(authority, request) : outcome === 'moved'
  if (!isCurrentPairing(authority)) {
    // A re-pair replaced the host this move was sent to; its own snapshots reconcile this window.
    await refreshWebRuntimeSessionTabsSnapshot(authority.environmentId, request.worktreeId, {
      acceptCurrentSnapshot: true
    })
    return
  }
  if (committed === null) {
    recheckLostReply(authority, request, hooks, recheckDelayMs)
    return
  }
  if (committed && movedHere) {
    hooks.onCommitted?.()
    return
  }
  if (outcome === 'refused') {
    hooks.onRefused?.()
  }
  if (!committed && movedHere) {
    await revertRefusedPaneMove(authority, request)
    if (outcome === 'unknown') {
      recheckLostReply(authority, request, hooks, recheckDelayMs)
    }
    return
  }
  await refreshFromHost(authority, request.worktreeId)
  if (committed) {
    hooks.onCommitted?.()
  }
}

function recheckLostReply(
  authority: PaneMoveHostAuthority,
  request: TerminalLeafMoveRequest,
  hooks: HostPaneMoveSettleHooks,
  delayMs: number
): void {
  setTimeout(() => {
    void (async () => {
      if (!isCurrentPairing(authority) || !(await hostHoldsMovedPane(authority, request))) {
        return
      }
      await refreshFromHost(authority, request.worktreeId)
      if (isCurrentPairing(authority)) {
        hooks.onCommitted?.()
      }
    })().catch((error: unknown) =>
      console.warn('[web-runtime-session] pane move recheck failed', error)
    )
  }, delayMs)
}

/**
 * Undoes this window's move after the host kept the pane: the pane's records go back to the source,
 * the tab the window drew goes without stopping its terminal, and the host's tabs are redrawn even
 * when the host's answer is unchanged.
 */
async function revertRefusedPaneMove(
  authority: PaneMoveHostAuthority,
  request: TerminalLeafMoveRequest
): Promise<void> {
  const state = useAppStore.getState()
  const userWasOnMovedTab = state.activeTabId === request.targetTabId
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
  await refreshFromHost(authority, request.worktreeId)
  // The pane is back in its source; the user who was typing in it keeps typing there.
  if (userWasOnMovedTab && useAppStore.getState().activeTabId === request.sourceTabId) {
    focusTerminalTabSurface(request.sourceTabId, request.leafId)
  }
}
