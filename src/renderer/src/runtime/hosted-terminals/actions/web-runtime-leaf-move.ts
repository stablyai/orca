import type { TerminalLeafMoveRequest } from '../../../../../shared/workspace-layout/terminal-topology/terminal-leaf-move'
import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { SESSION_TABS_MOVE_PANE_TO_NEW_TAB_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import { toHostSessionTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { isRecoverableRemoteRuntimeConnectionError } from '../../../../../shared/remote-runtime/remote-runtime-client-error-classification'
import { runtimeEnvironmentIdUnlessTwin } from '../../../lib/workspace/ownership/resolve-owner'
import { useAppStore } from '../../../store/index'
import { runtimeEnvironmentCapabilityProof } from '../../rpc/compatibility/runtime-capability-proof'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import { isWebRuntimeSessionActive } from '../../web-session-tabs-sync/identity/web-runtime-session-environment'
import { refreshWebRuntimeSessionTabsSnapshot } from '../../web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import { isCurrentSessionTabsRuntimeFrame } from '../../web-session-tabs-sync/tracking/publisher-identity-fences'
import { hostSnapshotAffirmsWorktreeContents } from '../../../../../shared/remote-runtime/session-graph/host-session-snapshot-authority'
import { getRuntimeEnvironmentRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import { focusTerminalTabSurface } from '../../../components/terminal-pane/input/focus/focus-terminal-tab-surface'
import {
  isFocusUnclaimed,
  isTerminalTabShown
} from '../../../components/terminal-pane/layout/detach/terminal-tab-shown'

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
 * The host admitted for one move: the runtime that proved the capability, on the pairing it was
 * asked over, serving this worktree. Every call of the move is pinned to that runtime and pairing,
 * and every local effect needs all three to still hold. A restart, re-pair or reroute hands the
 * window to the replacement host's snapshots; nothing from the old move applies.
 */
export type PaneMoveHostAuthority = {
  environmentId: string
  pairingRevision: number | undefined
  runtimeId: string
  worktreeId: string
}

/**
 * The admitted host still serves the worktree: same pairing, the worktree still routes to it, and
 * this window has not seen another runtime publish for it (a restart on the same pairing).
 */
export function isCurrentPaneMoveHost(authority: PaneMoveHostAuthority): boolean {
  return (
    getRuntimeEnvironmentRevision(authority.environmentId) === authority.pairingRevision &&
    routedEnvironmentId(authority.worktreeId) === authority.environmentId &&
    isCurrentSessionTabsRuntimeFrame(authority.environmentId, authority.runtimeId)
  )
}

function routedEnvironmentId(worktreeId: string): string | null {
  return runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), worktreeId)
}

/** Main refuses before sending when the host's runtime or pairing no longer matches. */
function callHost(
  authority: PaneMoveHostAuthority,
  args: { method: string; params: unknown }
): Promise<RuntimeRpcResponse<unknown>> {
  return window.api.runtimeEnvironments.call({
    selector: authority.environmentId,
    ...args,
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision: authority.pairingRevision,
    expectedEnvironmentRuntimeId: authority.runtimeId
  })
}

/** The answer came from another runtime than the admitted one, or was never sent to it. */
function answeredByAnotherHost(
  authority: PaneMoveHostAuthority,
  response: RuntimeRpcResponse<unknown>
): boolean {
  if (!response.ok && response.error.code === 'runtime_environment_changed') {
    return true
  }
  const runtimeId = response._meta?.runtimeId
  return (
    typeof runtimeId === 'string' && runtimeId.trim() !== '' && runtimeId !== authority.runtimeId
  )
}

/**
 * Ordinary reconciliation with whichever host serves the worktree now, nothing move-specific. Its
 * frame applies only while the worktree still routes to that host.
 */
async function reconcileWithCurrentHost(worktreeId: string): Promise<void> {
  const environmentId = routedEnvironmentId(worktreeId)
  if (!environmentId) {
    return
  }
  await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, {
    acceptCurrentSnapshot: true,
    isCurrent: () => routedEnvironmentId(worktreeId) === environmentId
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
  // The proof names the runtime and pairing that answered; a re-pair while it ran voids it.
  const proof = await runtimeEnvironmentCapabilityProof(
    environmentId,
    SESSION_TABS_MOVE_PANE_TO_NEW_TAB_RUNTIME_CAPABILITY
  ).catch(() => null)
  if (!proof?.supported) {
    return { kind: 'unavailable' }
  }
  const authority = {
    environmentId,
    pairingRevision: proof.pairingRevision,
    runtimeId: proof.runtimeId,
    worktreeId
  }
  return isCurrentPaneMoveHost(authority) ? { kind: 'host', authority } : { kind: 'unavailable' }
}

/**
 * The host's answer to a move: `unknown` when the reply was lost, so the host may have committed;
 * `superseded` when it was not the admitted host that answered (or the call never left this machine).
 */
export type HostPaneMoveOutcome = 'moved' | 'refused' | 'unknown' | 'superseded'

// Why: leaf-to-tab membership is host-authoritative for remote tabs; a local-only move reverts on the next snapshot.
export async function moveWebRuntimeLeafToNewTab(
  authority: PaneMoveHostAuthority,
  request: TerminalLeafMoveRequest,
  /** The drop's group and position as the host names them; an older host ignores them and appends. */
  placement: { targetGroupId: string; index?: number }
): Promise<HostPaneMoveOutcome> {
  let response: RuntimeRpcResponse<unknown>
  try {
    response = await callHost(authority, {
      method: 'session.tabs.movePaneToNewTab',
      params: {
        worktree: toRuntimeWorktreeSelector(request.worktreeId),
        sourceTabId: toHostSessionTabId(request.sourceTabId),
        targetTabId: toHostSessionTabId(request.targetTabId),
        leafId: request.leafId,
        ...placement
      }
    })
  } catch (error) {
    console.warn(
      '[web-runtime-session] no answer to the pane move:',
      error instanceof Error ? error.message : String(error)
    )
    return 'unknown'
  }
  if (answeredByAnotherHost(authority, response)) {
    return 'superseded'
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

/** What the admitted host holds: only its own list can prove the pane is, or is not, in the new tab. */
type MovedPaneCustody = 'held' | 'absent' | 'unaskable' | 'superseded'

async function hostHoldsMovedPane(
  authority: PaneMoveHostAuthority,
  request: TerminalLeafMoveRequest
): Promise<MovedPaneCustody> {
  let response: RuntimeRpcResponse<unknown>
  try {
    response = await callHost(authority, {
      method: 'session.tabs.list',
      params: { worktree: toRuntimeWorktreeSelector(request.worktreeId) }
    })
  } catch {
    return 'unaskable'
  }
  if (answeredByAnotherHost(authority, response)) {
    return 'superseded'
  }
  if (!response.ok || !isSessionTabsInventory(response.result)) {
    return 'unaskable'
  }
  const listed = response.result
  const hostTargetTabId = toHostSessionTabId(request.targetTabId)
  const held = listed.tabs.some(
    (tab: unknown) =>
      typeof tab === 'object' &&
      tab !== null &&
      'parentTabId' in tab &&
      'leafId' in tab &&
      tab.parentTabId === hostTargetTabId &&
      tab.leafId === request.leafId
  )
  if (held) {
    return 'held'
  }
  // Absence counts only from the host's published inventory of this worktree: a host with nothing
  // published yet (just restarted, say) lists it empty without attesting anything.
  return listed.worktree === request.worktreeId && hostSnapshotAffirmsWorktreeContents(listed)
    ? 'absent'
    : 'unaskable'
}

function isSessionTabsInventory(value: unknown): value is {
  worktree: unknown
  publicationEpoch?: string
  snapshotVersion: number
  tabs: unknown[]
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tabs' in value &&
    Array.isArray(value.tabs) &&
    'snapshotVersion' in value &&
    typeof value.snapshotVersion === 'number' &&
    (!('publicationEpoch' in value) ||
      value.publicationEpoch === undefined ||
      typeof value.publicationEpoch === 'string')
  )
}

export type HostPaneMoveSettleHooks = {
  /** Tells the user the host refused their move; absent for a move another client asked for. */
  onRefused?: () => void
}

/** A lost reply is asked about once more after this long; after that the host's snapshots decide. */
const LOST_REPLY_RECHECK_MS = 5_000

/**
 * Settles this window with the admitted host's answer. The host's versioned tab snapshots are the
 * only truth, and the host names the tab in its commit; this only decides what the window does until
 * the next snapshot lands (keyed by the move's fresh target tab id and leaf). Only a refusal by the
 * admitted host is reported or undone. A lost reply is checked once more later (bounded). An answer,
 * or a list, from a replacement host proves nothing about this move: the window just reconciles.
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
  const custody: MovedPaneCustody =
    outcome === 'superseded'
      ? 'superseded'
      : outcome === 'unknown'
        ? await hostHoldsMovedPane(authority, request)
        : outcome === 'moved'
          ? 'held'
          : 'absent'
  if (custody === 'superseded' || !isCurrentPaneMoveHost(authority)) {
    await reconcileWithCurrentHost(request.worktreeId)
    return
  }
  if (custody === 'unaskable') {
    recheckLostReply(authority, request, recheckDelayMs)
    return
  }
  if (custody === 'held') {
    if (!movedHere) {
      await reconcileWithCurrentHost(request.worktreeId)
    }
    return
  }
  if (outcome === 'refused') {
    hooks.onRefused?.()
  }
  if (movedHere) {
    await revertRefusedPaneMove(authority, request)
    if (outcome === 'unknown') {
      recheckLostReply(authority, request, recheckDelayMs)
    }
    return
  }
  await reconcileWithCurrentHost(request.worktreeId)
}

function recheckLostReply(
  authority: PaneMoveHostAuthority,
  request: TerminalLeafMoveRequest,
  delayMs: number
): void {
  setTimeout(() => {
    void (async () => {
      // A replacement host's snapshots already decide; its list says nothing about this move.
      if (
        !isCurrentPaneMoveHost(authority) ||
        (await hostHoldsMovedPane(authority, request)) !== 'held' ||
        !isCurrentPaneMoveHost(authority)
      ) {
        return
      }
      await reconcileWithCurrentHost(request.worktreeId)
    })().catch((error: unknown) =>
      console.warn('[web-runtime-session] pane move recheck failed', error)
    )
  }, delayMs)
}

/**
 * Undoes this window's move after the admitted host kept the pane: the pane's records go back to
 * the source, the tab the window drew goes without stopping its terminal, and the host's tabs are
 * redrawn even when the host's answer is unchanged.
 */
async function revertRefusedPaneMove(
  authority: PaneMoveHostAuthority,
  request: TerminalLeafMoveRequest
): Promise<void> {
  const state = useAppStore.getState()
  const userWasOnMovedTab = isTerminalTabShown(state, request.worktreeId, request.targetTabId)
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
  await reconcileWithCurrentHost(request.worktreeId)
  if (!userWasOnMovedTab) {
    return
  }
  // The pane is back in its source; the user who was typing in it keeps typing there, unless they
  // have since moved on (another tab, view or focused control) or the host was replaced.
  focusTerminalTabSurface(request.sourceTabId, request.leafId, {
    shouldFocus: () =>
      isCurrentPaneMoveHost(authority) &&
      isTerminalTabShown(useAppStore.getState(), request.worktreeId, request.sourceTabId) &&
      isFocusUnclaimed(request.sourceTabId)
  })
}
