/**
 * Parked terminal side-effect watcher.
 * Why: parking unmounts TerminalPane, so this replays its bell/title/agent-completion/PR-link side effects while parked.
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

// Why: keep the live path's BEL-vs-completion race window so notification behavior is identical whether a tab is parked or mounted.
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
  /** Stable terminal-layout leaf UUID; combined with tabId into the paneKey for cache-timer, unread, and notification attribution. */
  leafId: string
  /** PaneManager pane id the unmounted pane used; the watcher must write this same slot or a stale "working" title strands. */
  paneId: number
  /** Whether this PTY's pane was the tab's active split — only the focused split drives the tab title. */
  drivesTabTitle?: boolean
  /** Last runtime title at park time; seeds the agent tracker so an agent working at unmount still fires completion when it goes idle. */
  initialTitle?: string
  /** Pull main's title-only snapshot when a watcher starts before its pane ever mounted (ordinary park cycles already have a title). */
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

  // Why: one watcher per PTY — a stale watcher from a previous park cycle would double-fire bell/completion for the same bytes.
  parkedWatcherDisposersByPtyId.get(ptyId)?.()

  let disposed = false
  let pendingBellNotification = false
  // Why: a watcher-written title has no pane to overwrite it after reveal (stale 'working' pins status); track writes so dispose clears the exact slot.
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

  // Why: a BEL OS notification only yields when the pending completion would itself produce an OS notification (live-path parity).
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

  // Why: one policy block shared by both modes (byte parsing and facts) — semantics must be identical or flipping the switch changes behavior.
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
      // Why: agents emit BEL in the same burst as working→idle, so delay only the OS notification to let the richer completion notification win.
      pendingBellNotification = true
      if (!hasPendingAgentTaskCompleteNotification()) {
        scheduleTerminalBellNotification()
      }
    },
    onAgentBecameIdle: (title: string, meta?: { staleWorkingTitleClear?: boolean }): void => {
      // Why: stale-derived idles (main's 3s timer, not observed bytes) clear session state but must not schedule a completion a paused agent didn't earn.
      if (meta?.staleWorkingTitleClear) {
        useAppStore.getState().setCacheTimerStartedAt(paneKey, null)
        return
      }
      const state = useAppStore.getState()
      // Why: null settings means "not hydrated yet"; a spurious timestamp is harmless while a dropped one loses the timer.
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
        // Why: completion supersedes a concurrent BEL so each burst yields exactly one OS notification (live-path parity).
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
      // Why: a new API call refreshes the prompt-cache TTL, so clear the running countdown; it restarts when the agent next becomes idle.
      useAppStore.getState().setCacheTimerStartedAt(paneKey, null)
      clearAgentTaskCompleteTimer()
      if (pendingBellNotification) {
        scheduleTerminalBellNotification()
      }
    },
    onAgentExited: (): void => {
      // Why: title reverting to a plain shell means the agent session ended; clear the countdown so it doesn't survive in the sidebar while parked.
      useAppStore.getState().setCacheTimerStartedAt(paneKey, null)
    }
  }

  // Why: with the authority switch on, the fact consumer is the single policy consumer — registering byte parsers too would double-fire bells.
  const mainSideEffectAuthority = isMainTerminalSideEffectAuthorityForPty({
    settings: useAppStore.getState().settings,
    runtimeEnvironmentId: null
  })
  // Why: decided once at watcher start — it picks which 2031 responder (byte sidecar vs fact reply) exists, so it must never flip per chunk.
  const hiddenDeliveryGateActive =
    mainSideEffectAuthority &&
    isRendererHiddenPtyDeliveryGateEnabled(useAppStore.getState().settings)

  const sendMode2031Reply = (): void => {
    const settings = useAppStore.getState().settings
    sendInput(mode2031SequenceFor(resolveTerminalColorSchemeMode(settings, getSystemPrefersDark())))
  }

  // Why (byte-parser mode only): reuse the transport's output processor to keep exact live-path parsing semantics.
  // initialAgentTitle: an agent already working at park time still produces a working→idle transition.
  const processor = mainSideEffectAuthority
    ? null
    : createPtyOutputProcessor({
        ...(options.initialTitle !== undefined ? { initialAgentTitle: options.initialTitle } : {}),
        ...sideEffectCallbacks
      })
  // Why (byte-parser mode only): under main authority, byte-scanning PR links too would observe every link twice (facts already carry them).
  const observeTerminalGitHubPRLink = mainSideEffectAuthority
    ? null
    : createTerminalGitHubPRLinkDetector()
  const unregisterFactConsumer = mainSideEffectAuthority
    ? registerTerminalSideEffectFactConsumer({
        ptyId,
        // Why: ordinary park already has a pane-owned title; the flag below requests a snapshot only when no pane did.
        callbacks: {
          ...sideEffectCallbacks,
          onPrLink: (link) =>
            useAppStore.getState().observeTerminalGitHubPullRequestLink(worktreeId, link),
          // Why (gate mode only): the 2031 subscribe arrives as a fact, but the reply stays here — query authority stays with the view/watcher (invariant 6).
          ...(hiddenDeliveryGateActive ? { onMode2031Subscribe: sendMode2031Reply } : {})
        },
        // Why: activation-deferred tabs can start a watcher before any pane restored the title; ordinary parked tabs avoid this IPC.
        restoreTitleOnRegister: options.restoreTitleOnRegister === true
      })
    : null

  // Why: no xterm answers DECSET 2031 while parked; with the gate ON, the responder's sidecar would force-feed bytes to the gated PTY, so skip it.
  const stopMode2031Responder = hiddenDeliveryGateActive
    ? null
    : startParkedTerminalMode2031Responder({ ptyId, sendInput })

  // Why: parked tabs are the canonical hidden view — mark the PTY gated so main stops renderer byte delivery.
  const releaseHiddenDeliveryClaim = hiddenDeliveryGateActive
    ? acquireHiddenRendererPtyDeliveryClaim(ptyId)
    : null

  // Why (byte-parser mode only): under main authority, registering byte parsers here would double-fire policy already carried by facts.
  const unsubscribeByteParsers =
    processor === null
      ? null
      : subscribeToPtyData(ptyId, (data) => {
          // Why: empty pane callbacks — no xterm to deliver bytes to, the watcher wants only the parser side effects.
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
    // Why: unhide BEFORE the reveal remount registers pane handlers, so main resumes delivery and emits the restore marker the pane consumes.
    releaseHiddenDeliveryClaim?.()
    stopMode2031Responder?.()
    unsubscribeByteParsers?.()
    unregisterFactConsumer?.()
    // Why: clears tracker/timer/detector state so the watcher can't fire after the revealed pane's live parsers take over.
    processor?.clearAccumulatedState()
    clearBellNotificationTimer()
    clearAgentTaskCompleteTimer()
    pendingBellNotification = false
    // Why: store merge never deletes title slots, so a watcher-written entry would strand after reveal and pin worktree status 'working'.
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
