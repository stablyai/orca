import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTabCloseResult,
  RuntimeSessionTabCloseReason
} from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  clearWebSessionCloseIntent,
  makeWebSessionCloseIntentDurable,
  recordWebSessionCloseIntent
} from './web-session-close-intent'
import { settleWebSessionCloseReplay, type WebSessionCloseReplay } from './web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore } from './paired-terminal-tab-close-intent-store'
import {
  holdUndeliveredUserClose,
  isUndeliveredCloseFailure,
  scheduleWebSessionCloseReplayRelist
} from './web-session-undelivered-close'
import {
  clearWebSessionFocusIntent,
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent
} from './web-session-focus-intent'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive,
  matchesWebSessionIntentOwner
} from './web-runtime-session-environment'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import { isServerFrameDrawnWorkspace } from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { redrawServerLayoutWorkspace } from './server-layout-apply-routes'
import { userTabCloseParams } from './web-session-user-tab-close-params'

export async function activateWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
  /** The split pane the user picked; without it the host and focus intent pick the first. */
  leafId?: string | null
  /** The local tab visible at the gesture; later navigation away cancels the deferred focus. */
  expectedCurrentLocalTabId?: string | null
}): Promise<boolean> {
  // COMPAT(legacy-relay-bridge, revisit 2027-01-15): an older relay runs a pane in this tab, and
  // activating that pane on the managed server would start a second shell there that no tab shows.
  // A click names no leaf, so the pane on screen does; the server would otherwise pick the first.
  // Loaded lazily: the module subscribes to main's pane list on import, and terminal panes load it.
  const { hasLegacyRelayBridgedPane, isLegacyRelayBridgedTab } =
    await import('../components/terminal-pane/legacy-relay-bridge-panes')
  const leafId =
    args.leafId ??
    (hasLegacyRelayBridgedPane(args.tabId)
      ? useAppStore.getState().terminalLayoutsByTabId?.[args.tabId]?.activeLeafId
      : null)
  if (isLegacyRelayBridgedTab(args.tabId, leafId)) {
    // This gesture still supersedes an earlier tab's pending focus, as recording its own would.
    const environmentId = resolveTabEnvironmentId(args.environmentId)
    if (environmentId) {
      clearWebSessionFocusIntent(captureWebSessionIntentOwner(environmentId), args.worktreeId)
    }
    return true
  }
  return (
    (await callWebRuntimeSessionTabMethod('session.tabs.activate', { ...args, leafId })) ===
    'applied'
  )
}

/** Only unknown-tab proves definitive absence and permits teardown; timeouts/disconnects merely mean retry later and may leave a live host tab. */
export type WebRuntimeSessionTabCloseOutcome = 'applied' | 'unknown-tab' | 'failed'

export async function closeWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
  reason: RuntimeSessionTabCloseReason
  publicationEpoch?: string | null
  terminalHandle?: string | null
  /** A replay's pairing; the call is refused if the environment was re-paired since. */
  expectedPairingRevision?: number
  /** The user confirmed closing a pinned tab; sent only to hosts that honour it. */
  force?: boolean
  /** A held close re-sent, not a fresh click; marked so only to hosts that accept the mark. */
  replay?: true
}): Promise<WebRuntimeSessionTabCloseOutcome> {
  return callWebRuntimeSessionTabMethod('session.tabs.close', args)
}

/** Sends again the user closes a host snapshot proved reachable; see `takeDueWebSessionCloseReplays`. */
export async function replayWebSessionTabCloses(
  environmentId: string,
  replays: readonly WebSessionCloseReplay[]
): Promise<void> {
  for (const replay of replays) {
    // Why: the close was the old pairing's; a replacement host must never receive it.
    if (!matchesWebSessionIntentOwner(replay.owner)) {
      settleWebSessionCloseReplay(appPairedTerminalTabCloseIntentStore, replay, true)
      continue
    }
    const outcome = await closeWebRuntimeSessionTab({
      worktreeId: replay.worktreeId,
      tabId: replay.hostTabIds[0],
      environmentId,
      reason: 'user',
      replay: true,
      ...(replay.owner.pairingRevision !== undefined
        ? { expectedPairingRevision: replay.owner.pairingRevision }
        : {}),
      ...(replay.force ? { force: true } : {})
    })
    const settled = settleWebSessionCloseReplay(
      appPairedTerminalTabCloseIntentStore,
      replay,
      outcome !== 'failed'
    )
    if (settled === 'retry') {
      scheduleWebSessionCloseReplayRelist(environmentId, replay.worktreeId)
      continue
    }
    if (settled === 'done') {
      continue
    }
    // The host kept failing the close and its tab is shown again rather than hidden forever.
    // The unchanged snapshot that made this replay due would otherwise be refused as stale.
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, replay.worktreeId, {
      acceptCurrentSnapshot: true
    })
  }
}

function resolveTabEnvironmentId(environmentId: string | null | undefined): string | null {
  return (
    environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  )
}

async function callWebRuntimeSessionTabMethod(
  method: 'session.tabs.activate' | 'session.tabs.close',
  args: {
    worktreeId: string
    tabId: string
    environmentId?: string | null
    reason?: RuntimeSessionTabCloseReason
    publicationEpoch?: string | null
    terminalHandle?: string | null
    leafId?: string | null
    expectedCurrentLocalTabId?: string | null
    expectedPairingRevision?: number
    force?: boolean
    replay?: true
  }
): Promise<WebRuntimeSessionTabCloseOutcome> {
  const environmentId = resolveTabEnvironmentId(args.environmentId)
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    if (environmentId && method === 'session.tabs.close' && args.reason === 'user') {
      holdUndeliveredUserClose(
        captureWebSessionIntentOwner(environmentId),
        args.worktreeId,
        [toHostSessionTabId(args.tabId)],
        args.force
      )
    }
    return 'failed'
  }
  const intentOwner =
    args.expectedPairingRevision !== undefined
      ? { environmentId, pairingRevision: args.expectedPairingRevision }
      : captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)
  const closeIntentTabIds = new Set<string>()
  let activationHostTabId: string | null = null

  const isClose = method === 'session.tabs.close'
  const isLifecycleClose = isClose && args.reason !== 'user'
  if (isLifecycleClose && (!args.publicationEpoch || !args.terminalHandle)) {
    // Keep without host-generation/terminal-incarnation evidence; tab IDs can be stale or reused after reconnect.
    const { acceptReplayedWebSessionTabsSnapshot } =
      await import('./web-session-tabs-sync/tracking-lifecycle')
    acceptReplayedWebSessionTabsSnapshot(environmentId, args.worktreeId)
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId)
    console.warn('[web-runtime-session] suppressed lifecycle close without incarnation evidence', {
      closeReason: args.reason
    })
    return 'failed'
  }

  // Switch point: frames draw this workspace's tabs and focus, so the mirror's intent ledgers skip it.
  const frameDrawn = isServerFrameDrawnWorkspace(environmentId, args.worktreeId)
  const immediateHostTabId = toHostSessionTabId(args.tabId)
  // The host's id for this tab; a frame-drawn close that never arrived is held under it for replay.
  let closeHostTabId = immediateHostTabId
  if (isClose && !frameDrawn) {
    // Why: record before async id resolution so a stale snapshot cannot flash the closed tab back.
    closeIntentTabIds.add(immediateHostTabId)
    recordWebSessionCloseIntent(intentOwner, args.worktreeId, immediateHostTabId, Date.now())
  }

  try {
    const { resolveHostSessionTabIdForWebSessionTab } =
      await import('./web-session-tabs-sync/tracking-mappings')
    const state = useAppStore.getState()
    const hostTabId =
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId,
        worktreeId: args.worktreeId,
        tabId: args.tabId
      }) ?? toHostSessionTabId(args.tabId)
    closeHostTabId = hostTabId
    if (isClose && !frameDrawn) {
      // Why: suppress until the host confirms removal, else an in-flight pre-close snapshot flashes the tab back.
      closeIntentTabIds.add(hostTabId)
      recordWebSessionCloseIntent(intentOwner, args.worktreeId, hostTabId, Date.now())
    } else if (!isClose && !frameDrawn) {
      activationHostTabId = hostTabId
      recordWebSessionFocusIntent(
        intentOwner,
        args.worktreeId,
        hostTabId,
        args.leafId ?? undefined,
        args.expectedCurrentLocalTabId
      )
    }
    const userCloseParams =
      isClose && !isLifecycleClose ? await userTabCloseParams(environmentId, args) : {}
    const response = await callEnvironment({
      // Generation cutover must fail closed before old hosts’ destructive legacy close handlers; they lack this additive method.
      method: isLifecycleClose ? 'session.tabs.closeLifecycle' : method,
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId,
        ...(method === 'session.tabs.activate'
          ? {
              ...(args.leafId ? { leafId: args.leafId } : {}),
              // Why: the additive navigation target protects new hosts while notifyClients:false protects old hosts.
              notifyClients: false,
              navigation: 'caller' as const,
              // Tab clicks, shortcuts and palette picks must wake slept panes.
              intent: 'user' as const
            }
          : {}),
        ...(isLifecycleClose
          ? {
              reason: args.reason,
              publicationEpoch: args.publicationEpoch,
              terminal: args.terminalHandle
            }
          : isClose
            ? userCloseParams
            : {})
      },
      timeoutMs: WEB_SESSION_TAB_RPC_TIMEOUT_MS
    })
    const result = unwrapRuntimeRpcResult(
      response as RuntimeRpcResponse<RuntimeMobileSessionTabCloseResult | undefined>
    )
    if (isClose) {
      if (frameDrawn && result?.refused === true) {
        redrawServerLayoutWorkspace(environmentId, args.worktreeId)
      }
      if (result?.refused === true && result.snapshotRepublished === true) {
        // Restore authoritative live PTYs only on republication; keep dead-leaf refusals hidden.
        clearWebSessionCloseIntent(intentOwner, args.worktreeId, immediateHostTabId)
        clearWebSessionCloseIntent(intentOwner, args.worktreeId, hostTabId)
        const { acceptReplayedWebSessionTabsSnapshot } =
          await import('./web-session-tabs-sync/tracking-lifecycle')
        acceptReplayedWebSessionTabsSnapshot(environmentId, args.worktreeId)
      }
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
        expectedEnvironmentPairingRevision: intentOwner.pairingRevision
      })
    }
    return 'applied'
  } catch (error) {
    if (activationHostTabId) {
      clearWebSessionFocusIntentIfMatches(intentOwner, args.worktreeId, activationHostTabId)
    }
    // tab_not_found/terminal_tab_not_found prove absence: keep suppression without TTL or stale snapshots resurrect unclosable panes (#9194, #21189). selector_not_found is transient worktree discovery (remote-browser-stream-errors.ts); every other failure remains retryable.
    const hostHasNoSuchTab =
      hasRuntimeRpcErrorCode(error, 'tab_not_found') ||
      hasRuntimeRpcErrorCode(error, 'terminal_tab_not_found')
    const undeliveredUserClose =
      isClose && args.reason === 'user' && !hostHasNoSuchTab && isUndeliveredCloseFailure(error)
    if (isClose && frameDrawn && !undeliveredUserClose) {
      // The window dropped the tab; a refused close (a pinned tab, say) draws what the server kept.
      redrawServerLayoutWorkspace(environmentId, args.worktreeId)
    }
    if (undeliveredUserClose) {
      // Why: clearing here let the host's next snapshot bring back a tab the user closed (STA-6224).
      // The resolved host id was added last and is the one the host knows.
      holdUndeliveredUserClose(
        intentOwner,
        args.worktreeId,
        frameDrawn ? [closeHostTabId] : [...closeIntentTabIds].toReversed(),
        args.force
      )
    } else {
      for (const hostTabId of closeIntentTabIds) {
        if (hostHasNoSuchTab) {
          makeWebSessionCloseIntentDurable(intentOwner, args.worktreeId, hostTabId)
        } else {
          clearWebSessionCloseIntent(intentOwner, args.worktreeId, hostTabId)
        }
      }
    }
    if (isLifecycleClose) {
      const { acceptReplayedWebSessionTabsSnapshot } =
        await import('./web-session-tabs-sync/tracking-lifecycle')
      acceptReplayedWebSessionTabsSnapshot(environmentId, args.worktreeId)
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
        expectedEnvironmentPairingRevision: intentOwner.pairingRevision
      })
    }
    console.warn(
      `[web-runtime-session] failed to ${isClose ? 'close' : 'activate'} tab:`,
      error instanceof Error ? error.message : String(error)
    )
    return hostHasNoSuchTab ? 'unknown-tab' : 'failed'
  }
}
