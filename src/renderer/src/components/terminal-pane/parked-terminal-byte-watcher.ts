/**
 * Parked terminal side-effect watcher.
 *
 * Why: parking unmounts the TerminalPane subtree, which tears down the pane's
 * side-effect consumers — the parked tab's only source of bell, title,
 * agent-completion, and PR-link policy. (Losing them is the gap that sank the
 * first parking attempt.) Under main side-effect authority the watcher is
 * purely fact-driven (one pty:sideEffect consumer, no byte parsing); with the
 * kill switch off it registers the legacy byte parsers on the dispatcher
 * sidecar channel. DECSET 2031 ownership follows the hidden-delivery gate:
 * gate ON answers from main's '2031-subscribe' fact (no parked bytes exist),
 * gate OFF keeps the byte sidecar (parked-terminal-mode2031-responder.ts).
 * Either way the reply is sent from the renderer — query authority never
 * moves to main.
 */
import { isClaudeAgent } from '../../../../shared/agent-detection'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import {
  mode2031SequenceFor,
  resolveTerminalColorSchemeMode
} from '../../../../shared/terminal-color-scheme-protocol'
import { createTerminalGitHubPRLinkDetector } from '../../../../shared/terminal-github-pr-link-detector'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import {
  AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS,
  isAgentTaskCompleteOsNotificationEnabledFromState,
  isAgentTaskCompleteTrackingEnabledFromState
} from './agent-task-complete-policy'
import { startParkedTerminalMode2031Responder } from './parked-terminal-mode2031-responder'
import { subscribeToPtyData } from './pty-data-sidecar-subscriptions'
import { createPtyOutputProcessor } from './pty-transport'
import { isRendererHiddenPtyDeliveryGateEnabled } from './terminal-hidden-delivery-gate'
import {
  isMainTerminalSideEffectAuthorityForPty,
  registerTerminalSideEffectFactConsumer
} from './terminal-side-effect-facts-handler'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import { acquireHiddenRendererPtyDeliveryClaim } from './pty-renderer-delivery-claims'

// Why: mirrors AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS in pty-connection.ts.
// The parked path must keep the live path's BEL-vs-completion race window so
// notification behavior is identical whether a tab is parked or mounted.
const PARKED_NOTIFICATION_GRACE_MS = AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS

type StoreState = ReturnType<typeof useAppStore.getState>

function isAgentTaskCompleteOsNotificationEnabled(state: StoreState): boolean {
  return isAgentTaskCompleteOsNotificationEnabledFromState(state)
}

function isAgentTaskCompleteTrackingEnabled(state: StoreState): boolean {
  return isAgentTaskCompleteTrackingEnabledFromState(state)
}

export type ParkedTerminalByteWatcherOptions = {
  ptyId: string
  tabId: string
  worktreeId: string
  /** Stable terminal-layout leaf UUID. Combined with tabId into the paneKey
   *  used for cache-timer, unread, and notification attribution. */
  leafId: string
  /** PaneManager pane id the unmounted pane used. Runtime pane titles are
   *  keyed by it, so the watcher must write the slot the live path wrote —
   *  a different id would leave a stale (possibly "working") title behind. */
  paneId: number
  /** Whether this PTY's pane was the tab's active split pane. Mirrors the
   *  live path, where only the focused split drives the tab title. */
  drivesTabTitle?: boolean
  /** The pane's last known runtime title at park time. Seeds the agent
   *  tracker so an agent that was working when the pane unmounted still
   *  fires its completion when it goes idle while parked. */
  initialTitle?: string
  /** Pull main's title-only snapshot when a watcher starts before its pane
   *  has ever mounted. Ordinary park cycles already have a current title. */
  restoreTitleOnRegister?: boolean
  /** Out-of-band reply channel to the PTY (mode-2031 color-scheme answers). */
  sendInput: (data: string) => void
}

const parkedWatcherDisposersByPtyId = new Map<string, () => void>()

export function startParkedTerminalByteWatcher(
  options: ParkedTerminalByteWatcherOptions
): () => void {
  const { ptyId, tabId, worktreeId, paneId, sendInput } = options
  const drivesTabTitle = options.drivesTabTitle ?? true
  const paneKey = makePaneKey(tabId, options.leafId)

  // Why: one watcher per PTY. A stale watcher from a previous park cycle would
  // double-fire bell/completion side effects for the same bytes.
  parkedWatcherDisposersByPtyId.get(ptyId)?.()

  let disposed = false
  let pendingBellNotification = false
  // Why: a watcher-written runtime title (especially into a negative fallback
  // slot) has no live pane to overwrite it after reveal; a stale 'working'
  // entry would pin worktree status forever. Track writes so dispose can
  // clear exactly the slot this watcher touched.
  let wroteRuntimeTitleSlot = false
  let bellNotificationTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteTimer: ReturnType<typeof setTimeout> | null = null

  const clearBellNotificationTimer = (): void => {
    if (bellNotificationTimer !== null) {
      clearTimeout(bellNotificationTimer)
      bellNotificationTimer = null
    }
  }

  const clearAgentTaskCompleteTimer = (): void => {
    if (agentTaskCompleteTimer !== null) {
      clearTimeout(agentTaskCompleteTimer)
      agentTaskCompleteTimer = null
    }
  }

  // Why: like the live path, a BEL OS notification only yields when the
  // pending completion would itself produce an OS notification.
  const hasPendingAgentTaskCompleteNotification = (): boolean =>
    agentTaskCompleteTimer !== null &&
    isAgentTaskCompleteOsNotificationEnabled(useAppStore.getState())

  const scheduleTerminalBellNotification = (): void => {
    if (bellNotificationTimer !== null) {
      return
    }
    bellNotificationTimer = setTimeout(() => {
      bellNotificationTimer = null
      if (disposed) {
        pendingBellNotification = false
        return
      }
      if (hasPendingAgentTaskCompleteNotification()) {
        return
      }
      pendingBellNotification = false
      dispatchTerminalNotification(worktreeId, { source: 'terminal-bell', paneKey })
    }, PARKED_NOTIFICATION_GRACE_MS)
  }

  // Why: one policy block for both consumption modes — byte parsing (kill
  // switch off) and pty:sideEffect facts (main authority on). The semantics
  // must be identical or flipping the switch changes notification behavior.
  const sideEffectCallbacks = {
    onTitleChange: (title: string): void => {
      const state = useAppStore.getState()
      wroteRuntimeTitleSlot = true
      state.setRuntimePaneTitle(tabId, paneId, title)
      if (drivesTabTitle) {
        state.updateTabTitle(tabId, title)
      }
    },
    onBell: (): void => {
      const state = useAppStore.getState()
      state.markWorktreeUnread(worktreeId)
      state.markTerminalTabUnread(tabId)
      if (state.settings?.experimentalTerminalAttention === true) {
        state.markTerminalPaneUnread(paneKey)
      }
      // Why: agent CLIs often emit BEL in the same completion burst as their
      // working→idle title change. Delay only the OS notification so the
      // richer agent-task-complete notification can win (live-path parity).
      pendingBellNotification = true
      if (!hasPendingAgentTaskCompleteNotification()) {
        scheduleTerminalBellNotification()
      }
    },
    onAgentBecameIdle: (title: string, meta?: { staleWorkingTitleClear?: boolean }): void => {
      // Why: stale-derived idles come from main's unthrottled 3s timer, not
      // observed bytes — clear session state, never schedule the completion
      // notification a merely-paused agent did not earn (live-path parity).
      if (meta?.staleWorkingTitleClear) {
        useAppStore.getState().setCacheTimerStartedAt(paneKey, null)
        return
      }
      const state = useAppStore.getState()
      // Why: mirrors pty-connection — null settings means "not hydrated yet";
      // a spurious timestamp is harmless while a dropped one loses the timer.
      if (
        isClaudeAgent(title) &&
        (state.settings === null || state.settings.promptCacheTimerEnabled)
      ) {
        state.setCacheTimerStartedAt(paneKey, Date.now())
      }
      if (!isAgentTaskCompleteTrackingEnabled(state)) {
        return
      }
      clearAgentTaskCompleteTimer()
      agentTaskCompleteTimer = setTimeout(() => {
        agentTaskCompleteTimer = null
        if (disposed) {
          return
        }
        // Why: the completion supersedes a concurrent BEL so each completion
        // burst yields exactly one OS notification, same as the live path.
        pendingBellNotification = false
        clearBellNotificationTimer()
        dispatchTerminalNotification(worktreeId, {
          source: 'agent-task-complete',
          terminalTitle: title,
          paneKey,
          ...(isAgentTaskCompleteOsNotificationEnabled(useAppStore.getState())
            ? {}
            : { suppressOsNotification: true })
        })
      }, PARKED_NOTIFICATION_GRACE_MS)
    },
    onAgentBecameWorking: (): void => {
      // Why: a new API call refreshes the prompt-cache TTL, so clear any
      // running countdown; it restarts when the agent next becomes idle.
      useAppStore.getState().setCacheTimerStartedAt(paneKey, null)
      clearAgentTaskCompleteTimer()
      if (pendingBellNotification) {
        scheduleTerminalBellNotification()
      }
    },
    onAgentExited: (): void => {
      // Why: title reverting to a plain shell means the agent session ended;
      // a stale countdown must not survive in the sidebar while parked.
      useAppStore.getState().setCacheTimerStartedAt(paneKey, null)
    }
  }

  // Why: parking eligibility excludes remote-runtime and SSH PTYs, so every
  // watched PTY's bytes transit local main — when the authority switch is on,
  // the watcher must NOT register byte parsers (the fact consumer below is
  // the single policy consumer; double registration would double-fire bells).
  const mainSideEffectAuthority = isMainTerminalSideEffectAuthorityForPty({
    settings: useAppStore.getState().settings,
    runtimeEnvironmentId: null
  })
  // Why: under the Phase-4 gate a parked PTY needs no renderer bytes at all —
  // facts carry side effects and the reveal remount restores from the model
  // snapshot. Decided once at watcher start: it picks which 2031 responder
  // (byte sidecar vs fact reply) exists, so it must never flip per chunk.
  const hiddenDeliveryGateActive =
    mainSideEffectAuthority &&
    isRendererHiddenPtyDeliveryGateEnabled(useAppStore.getState().settings)

  const sendMode2031Reply = (): void => {
    const settings = useAppStore.getState().settings
    sendInput(mode2031SequenceFor(resolveTerminalColorSchemeMode(settings, getSystemPrefersDark())))
  }

  // Why (byte-parser mode only): reuse the transport's output processor so
  // the parked path keeps the exact live-path parsing semantics — all-titles
  // ordering, normalization, the cursor-agent native-title drop, the
  // OSC-aware stateful bell detector, and the working/idle agent tracker.
  // initialAgentTitle: an agent already working at park time must still
  // produce a working→idle transition; main's continuous tracker covers this
  // in fact-consumer mode.
  const processor = mainSideEffectAuthority
    ? null
    : createPtyOutputProcessor({
        ...(options.initialTitle !== undefined ? { initialAgentTitle: options.initialTitle } : {}),
        ...sideEffectCallbacks
      })
  // Why (byte-parser mode only): with main authority, pr-link facts arrive on
  // the channel below; byte-scanning too would observe every link twice.
  const observeTerminalGitHubPRLink = mainSideEffectAuthority
    ? null
    : createTerminalGitHubPRLinkDetector()
  const unregisterFactConsumer = mainSideEffectAuthority
    ? registerTerminalSideEffectFactConsumer({
        ptyId,
        // Why: ordinary park already has a current pane-owned title; the cold
        // activation flag below requests a snapshot only when no pane did.
        callbacks: {
          ...sideEffectCallbacks,
          onPrLink: (link) =>
            useAppStore.getState().observeTerminalGitHubPullRequestLink(worktreeId, link),
          // Why (gate mode only): bytes never arrive while gated, so the 2031
          // subscribe arrives as a main-tracker fact instead of a byte scan.
          // The reply is still sent from here — query authority stays with
          // the view/watcher (model/view contract invariant 6).
          ...(hiddenDeliveryGateActive ? { onMode2031Subscribe: sendMode2031Reply } : {})
        },
        // Why: activation-deferred tabs can start a watcher before any pane
        // restored the current title; ordinary parked tabs avoid this IPC.
        restoreTitleOnRegister: options.restoreTitleOnRegister === true
      })
    : null

  // Why: no xterm exists while parked, so nothing answers a DECSET 2031
  // subscription. With the hidden-delivery gate OFF the byte responder is the
  // parked path's only byte consumer under main authority. With the gate ON it
  // must NOT register: its subscribeToPtyData sidecar doubles as a
  // delivery-interest signal that would force-feed bytes to the gated PTY —
  // the fact callback above replaces the byte scan.
  const stopMode2031Responder = hiddenDeliveryGateActive
    ? null
    : startParkedTerminalMode2031Responder({ ptyId, sendInput })

  // Why: parked tabs are the canonical hidden view — mark the PTY gated so
  // main stops renderer byte delivery; dispose clears the bit before the
  // reveal remount re-registers pane handlers (existing dispose ordering).
  const releaseHiddenDeliveryClaim = hiddenDeliveryGateActive
    ? acquireHiddenRendererPtyDeliveryClaim(ptyId)
    : null

  // Why (byte-parser mode only): with main authority the watcher consumes
  // pty:sideEffect facts exclusively and registers NO byte parsers here —
  // title/bell/agent parsing and the PR-link scan would double-fire policy.
  const unsubscribeByteParsers =
    processor === null
      ? null
      : subscribeToPtyData(ptyId, (data) => {
          // Why: empty pane callbacks — the watcher wants only the parser
          // side effects; there is no xterm to deliver bytes to.
          processor.processData(data, {})
          if (observeTerminalGitHubPRLink) {
            for (const link of observeTerminalGitHubPRLink(data)) {
              useAppStore.getState().observeTerminalGitHubPullRequestLink(worktreeId, link)
            }
          }
        })

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    // Why: unhide BEFORE the reveal remount registers pane handlers — main
    // resumes delivery and (if bytes were dropped) emits the restore marker
    // the remounted pane's restore machinery consumes.
    releaseHiddenDeliveryClaim?.()
    stopMode2031Responder?.()
    unsubscribeByteParsers?.()
    unregisterFactConsumer?.()
    // Why: cancels the deferred side-effect drain, stale-title timer, and
    // tracker/bell-detector state so the watcher cannot fire after the
    // revealed pane's live parsers take over.
    processor?.clearAccumulatedState()
    clearBellNotificationTimer()
    clearAgentTaskCompleteTimer()
    pendingBellNotification = false
    // Why: the store merge never deletes title slots, so a watcher-written
    // entry would strand after reveal (the revealing pane re-registers under
    // its own pane id) and could pin worktree status 'working'. The revealed
    // pane repopulates its slot via its own title flow.
    if (wroteRuntimeTitleSlot) {
      wroteRuntimeTitleSlot = false
      useAppStore.getState().clearRuntimePaneTitle(tabId, paneId)
    }
    if (parkedWatcherDisposersByPtyId.get(ptyId) === dispose) {
      parkedWatcherDisposersByPtyId.delete(ptyId)
    }
  }
  parkedWatcherDisposersByPtyId.set(ptyId, dispose)
  return dispose
}
