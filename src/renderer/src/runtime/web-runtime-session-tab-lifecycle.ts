import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTabCloseResult,
  RuntimeSessionTabCloseReason
} from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  clearWebSessionCloseIntent,
  makeWebSessionCloseIntentDurable,
  recordWebSessionCloseIntent
} from './web-session-close-intent'
import {
  holdWebSessionCloseForReplay,
  settleWebSessionCloseReplay,
  type WebSessionCloseReplay
} from './web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore } from './paired-terminal-tab-close-intent-store'
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

/**
 * Why 'unknown-tab' is its own outcome: it is the host's definitive answer that it has no such
 * tab, which is the only evidence that lets a client finish a teardown the host cannot. Every
 * other failure -- a dropped connection, a timeout -- is a "not now", and treating it the same
 * would tear down tabs a reachable host still holds.
 */
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
}): Promise<WebRuntimeSessionTabCloseOutcome> {
  return callWebRuntimeSessionTabMethod('session.tabs.close', args)
}

// Why these and a bare rejection only: they mean the close never reached the host, so sending it
// again is the user's own close. A structured refusal (e.g. a re-paired host) is an answer.
// A Disconnect is answered by this client, not the host, so a tab closed meanwhile stays closed.
const UNDELIVERED_CLOSE_CODES = new Set([
  'runtime_manually_disconnected',
  'runtime_unavailable',
  'remote_runtime_unavailable',
  'runtime_timeout',
  'remote_runtime_timeout'
])

function isUndeliveredCloseFailure(error: unknown): boolean {
  return !(error instanceof RuntimeRpcCallError) || UNDELIVERED_CLOSE_CODES.has(error.code)
}

/** Keeps a user close the host never received, hiding the tab until a replay reaches the host. */
function holdUndeliveredUserClose(
  intentOwner: ReturnType<typeof captureWebSessionIntentOwner>,
  worktreeId: string,
  hostTabIds: readonly string[]
): void {
  holdWebSessionCloseForReplay(
    appPairedTerminalTabCloseIntentStore,
    intentOwner,
    worktreeId,
    hostTabIds
  )
  scheduleWebSessionCloseReplayRelist(intentOwner.environmentId, worktreeId)
}

const WEB_SESSION_CLOSE_REPLAY_RETRY_DELAY_MS = 5_000

// Why a re-list: subscriptions are change-driven, so an idle worktree may never publish the
// snapshot that makes the next attempt due. The re-list's receipt does.
function scheduleWebSessionCloseReplayRelist(environmentId: string, worktreeId: string): void {
  setTimeout(() => {
    void refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId)
  }, WEB_SESSION_CLOSE_REPLAY_RETRY_DELAY_MS)
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
      ...(replay.owner.pairingRevision !== undefined
        ? { expectedPairingRevision: replay.owner.pairingRevision }
        : {})
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
  }
): Promise<WebRuntimeSessionTabCloseOutcome> {
  const environmentId = resolveTabEnvironmentId(args.environmentId)
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    if (environmentId && method === 'session.tabs.close' && args.reason === 'user') {
      holdUndeliveredUserClose(captureWebSessionIntentOwner(environmentId), args.worktreeId, [
        toHostSessionTabId(args.tabId)
      ])
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
    // Why: missing host-generation or terminal-incarnation evidence means keep;
    // a tab id alone can be stale or reused after reconnect.
    const { acceptReplayedWebSessionTabsSnapshot } =
      await import('./web-session-tabs-sync/tracking-lifecycle')
    acceptReplayedWebSessionTabsSnapshot(environmentId, args.worktreeId)
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId)
    console.warn('[web-runtime-session] suppressed lifecycle close without incarnation evidence', {
      closeReason: args.reason
    })
    return 'failed'
  }

  const immediateHostTabId = toHostSessionTabId(args.tabId)
  if (isClose) {
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
    if (isClose) {
      // Why: suppress until the host confirms removal, else an in-flight pre-close snapshot flashes the tab back.
      closeIntentTabIds.add(hostTabId)
      recordWebSessionCloseIntent(intentOwner, args.worktreeId, hostTabId, Date.now())
    } else {
      activationHostTabId = hostTabId
      recordWebSessionFocusIntent(
        intentOwner,
        args.worktreeId,
        hostTabId,
        args.leafId ?? undefined,
        args.expectedCurrentLocalTabId
      )
    }
    const response = await callEnvironment({
      // Why: old hosts cannot route this additive method, so a generation
      // cutover fails closed before their destructive legacy close handler.
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
              // Why: every caller here is a tab click, shortcut, or palette pick —
              // the gesture that is supposed to wake a slept pane.
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
            ? { reason: args.reason }
            : {})
      },
      timeoutMs: WEB_SESSION_TAB_RPC_TIMEOUT_MS
    })
    const result = unwrapRuntimeRpcResult(
      response as RuntimeRpcResponse<RuntimeMobileSessionTabCloseResult | undefined>
    )
    if (isClose) {
      if (result?.refused === true && result.snapshotRepublished === true) {
        // Why: the host kept an authoritative live PTY. Stop hiding its mirror
        // only when it republished; dead-leaf refusals must stay suppressed.
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
    // Why the split: 'tab_not_found' and 'terminal_tab_not_found' prove definitive surface absence.
    // Restoring the mirror on it hands the user back a pane the host cannot close and whose handle is already gone (#9194, #21189),
    // so keep the suppression and drop its TTL instead.
    // 'selector_not_found' is a transient worktree resolver state (e.g. during scans or cache warm-up,
    // per remote-browser-stream-errors.ts) and must not become a durable close tombstone.
    // Every other failure is a "not now".
    const hostHasNoSuchTab =
      hasRuntimeRpcErrorCode(error, 'tab_not_found') ||
      hasRuntimeRpcErrorCode(error, 'terminal_tab_not_found')
    if (
      isClose &&
      args.reason === 'user' &&
      !hostHasNoSuchTab &&
      isUndeliveredCloseFailure(error)
    ) {
      // Why: clearing here let the host's next snapshot bring back a tab the user closed (STA-6224).
      // The resolved host id was added last and is the one the host knows.
      holdUndeliveredUserClose(intentOwner, args.worktreeId, [...closeIntentTabIds].toReversed())
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
