/** Keep mounted-pane bell/title/completion/PR-link policy active while parking unmounts TerminalPane. */
import { isClaudeIdleEdge } from '@/lib/agent-idle-edge'
import type { AgentIdleEdgeMeta } from '../../../../shared/terminal-output-side-effects'
import { resolveTerminalNotificationOwner } from '@/attention/notification-subject-owner'
import type { NotificationWorkspaceOwner } from '../../../../shared/notification-source'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { createTerminalGitHubPRLinkDetector } from '../../../../shared/terminal-github-pr-link-detector'
import {
  AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS,
  AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS,
  isAgentTaskCompleteOsNotificationEnabledFromState,
  isAgentTaskCompleteTrackingEnabledFromState
} from './agent-task-complete-policy'
import { createCommandCodeOutputStatusDetector } from '../../../../shared/command-code-output-status'
import { createOsc133CommandFinishedScanner } from '../../../../shared/terminal-osc133-command-finished'
import {
  createParkedTerminalCommandStatusPolicy,
  readInFlightCommandCodeTurn
} from './parked-terminal-command-status'
import { subscribeToPtyData } from './pty-data-sidecar-subscriptions'
import { createPtyOutputProcessor } from './pty-output-processor'
import { isRendererHiddenPtyDeliveryGateEnabled } from './terminal-hidden-delivery-gate'
import {
  isMainTerminalSideEffectAuthorityForPty,
  registerTerminalSideEffectFactConsumer
} from './terminal-side-effect-facts-handler'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import { hasPendingHookLaneCompletion } from '@/hooks/agent-hook-completion-notifications'
import { hookLaneTitleTurnEndEvidence } from '@/hooks/agent-hook-turn-end-ownership'
import { acquireHiddenRendererPtyDeliveryClaim } from './pty-renderer-delivery-claims'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'

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
  workspaceOwner?: NotificationWorkspaceOwner
  ptyId: string
  tabId: string
  worktreeId: string
  /** Stable leaf UUID combined with tabId for cache, unread and notification attribution. */
  leafId: string
  /** Reuse the unmounted pane’s numeric title slot so stale working status cannot strand. */
  paneId: number
  /** Whether this PTY's pane was the tab's active split — only the focused split drives the tab title. */
  drivesTabTitle?: boolean
  /** Seed working state so the recreated tracker recognizes completion after park. */
  initialTitle?: string
  /** Pull main's title-only snapshot when a watcher starts before its pane ever mounted (ordinary park cycles already have a title). */
  restoreTitleOnRegister?: boolean
}

const parkedWatcherDisposersByPtyId = new Map<string, () => void>()

export function startParkedTerminalByteWatcher(
  options: ParkedTerminalByteWatcherOptions
): () => void {
  const { ptyId, tabId, worktreeId, paneId } = options
  const remoteRuntimePty = isRemoteRuntimePtyId(ptyId)
  const drivesTabTitle = options.drivesTabTitle ?? true
  const paneKey = makePaneKey(tabId, options.leafId)
  const workspaceOwner =
    options.workspaceOwner ??
    resolveTerminalNotificationOwner(useAppStore.getState(), worktreeId, { paneKey, ptyId }) ??
    undefined

  // Why: one watcher per PTY — a stale watcher from a previous park cycle would double-fire bell/completion for the same bytes.
  parkedWatcherDisposersByPtyId.get(ptyId)?.()

  let disposed = false
  let pendingBellNotification = false
  // Track exact title writes: no mounted pane can replace them, and stale working titles pin status.
  let wroteRuntimeTitleSlot = false
  let bellNotificationTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteTimer: ReturnType<typeof setTimeout> | null = null
  let ownedIdleTimer: ReturnType<typeof setTimeout> | null = null

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
    if (ownedIdleTimer !== null) {
      clearTimeout(ownedIdleTimer)
      ownedIdleTimer = null
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
      // Why: the hook lane's pending Done announces this burst's turn end, superseding the BEL as a pane completion does.
      if (
        hasPendingHookLaneCompletion(paneKey, ptyId) &&
        isAgentTaskCompleteOsNotificationEnabled(useAppStore.getState())
      ) {
        return
      }
      dispatchTerminalNotification(worktreeId, {
        source: 'terminal-bell',
        paneKey,
        ptyId,
        workspaceOwner
      })
    }, PARKED_NOTIFICATION_GRACE_MS)
  }

  // Byte mode and fact mode share policy so switching authority preserves behavior.
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
      useAppStore.getState().markTerminalBell({ worktreeId, tabId, paneKey })
      // Why: agents emit BEL in the same burst as working→idle, so delay only the OS notification to let the richer completion notification win.
      pendingBellNotification = true
      if (!hasPendingAgentTaskCompleteNotification()) {
        scheduleTerminalBellNotification()
      }
    },
    onAgentBecameIdle: (title: string, meta?: AgentIdleEdgeMeta): void => {
      // Stale-title expiry clears state without granting unobserved completion to a paused agent.
      if (meta?.staleWorkingTitleClear) {
        useAppStore.getState().setCacheTimerStartedAt(paneKey, null)
        return
      }
      const state = useAppStore.getState()
      // Why: null settings means "not hydrated yet"; a spurious timestamp is harmless while a dropped one loses the timer.
      if (
        isClaudeIdleEdge(title, state.agentStatusByPaneKey[paneKey]) &&
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
        const evidence = (): 'identified' | 'ambiguous' | null => {
          const foreground = useAppStore.getState().paneForegroundAgentByPaneKey[paneKey]?.agent
          return hookLaneTitleTurnEndEvidence(paneKey, ptyId, title, foreground ?? null)
        }
        const dispatchIdleCompletion = (): void => {
          dispatchTerminalNotification(worktreeId, {
            source: 'agent-task-complete',
            terminalTitle: title,
            paneKey,
            ptyId,
            workspaceOwner
          })
        }
        if (evidence() !== 'identified') {
          dispatchIdleCompletion()
          return
        }
        // Why: as on a mounted pane, an end the host then calls ambiguous keeps main's title completion.
        ownedIdleTimer = setTimeout(() => {
          ownedIdleTimer = null
          if (!disposed && evidence() === 'ambiguous') {
            dispatchIdleCompletion()
          }
        }, AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - PARKED_NOTIFICATION_GRACE_MS)
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

  // Keep store-level command policy here; foreground confirmation and input-intent inference stay with mounted panes.
  const commandStatusPolicy = createParkedTerminalCommandStatusPolicy({
    ptyId,
    worktreeId,
    tabId,
    paneId,
    paneKey
  })

  // Main-derived facts own policy under main authority; byte parsers would double-fire side effects.
  const mainSideEffectAuthority =
    !remoteRuntimePty &&
    isMainTerminalSideEffectAuthorityForPty({
      settings: useAppStore.getState().settings,
      runtimeEnvironmentId: null
    })
  const factSideEffectAuthority = mainSideEffectAuthority || remoteRuntimePty
  const hiddenDeliveryGateActive =
    mainSideEffectAuthority &&
    isRendererHiddenPtyDeliveryGateEnabled(useAppStore.getState().settings)

  // Reuse live-path parsing and seed working identity for completion after park.
  const processor = factSideEffectAuthority
    ? null
    : createPtyOutputProcessor({
        ...(options.initialTitle !== undefined ? { initialAgentTitle: options.initialTitle } : {}),
        ...sideEffectCallbacks
      })
  // In byte mode, scan PR links; main-authority mode already receives them as facts.
  const observeTerminalGitHubPRLink = factSideEffectAuthority
    ? null
    : createTerminalGitHubPRLinkDetector()
  // Byte mode uses the same shared parsers as mounted panes; main mode receives equivalent facts.
  const commandFinishedScanner = factSideEffectAuthority
    ? null
    : createOsc133CommandFinishedScanner(commandStatusPolicy.onCommandFinished)
  // Seed Command Code’s in-flight turn: the banner is gone and the recreated detector otherwise misses return to idle.
  const commandCodeOutputStatusDetector = factSideEffectAuthority
    ? null
    : createCommandCodeOutputStatusDetector({
        inFlightTurn: readInFlightCommandCodeTurn(paneKey),
        onWorking: commandStatusPolicy.onCommandCodeWorking,
        onDone: commandStatusPolicy.onCommandCodeDone
      })
  const unregisterFactConsumer = factSideEffectAuthority
    ? registerTerminalSideEffectFactConsumer({
        ptyId,
        // Why: ordinary park already has a pane-owned title; the flag below requests a snapshot only when no pane did.
        callbacks: {
          ...sideEffectCallbacks,
          onCommandFinished: commandStatusPolicy.onCommandFinished,
          onCommandCodeWorking: commandStatusPolicy.onCommandCodeWorking,
          onCommandCodeDone: commandStatusPolicy.onCommandCodeDone,
          onPrLink: (link) =>
            useAppStore.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, {
              tabId,
              paneKey,
              ptyId,
              executionHostId: workspaceOwner?.executionHostId ?? undefined
            })
        },
        // Only activation-deferred panes need an initial title snapshot; ordinary parks already have a pane title.
        restoreTitleOnRegister: options.restoreTitleOnRegister === true
      })
    : null

  // Why: parked tabs are the canonical hidden view — mark the PTY gated so main stops renderer byte delivery.
  const releaseHiddenDeliveryClaim = hiddenDeliveryGateActive
    ? acquireHiddenRendererPtyDeliveryClaim(ptyId)
    : null

  const processLiveData = (data: string): void => {
    if (!processor) {
      return
    }
    processor.processData(data, {})
    commandFinishedScanner?.scan(data)
    commandCodeOutputStatusDetector?.observe(data)
    if (observeTerminalGitHubPRLink) {
      for (const link of observeTerminalGitHubPRLink(data)) {
        useAppStore.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, {
          tabId,
          paneKey,
          ptyId,
          executionHostId: workspaceOwner?.executionHostId ?? undefined
        })
      }
    }
  }
  // Paired hosts deliver facts on the environment stream; parked PTYs consume no multiplex slots or raw bytes.
  const unsubscribeByteParsers =
    processor === null ? null : subscribeToPtyData(ptyId, processLiveData)

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    // Drop the per-cycle processor gauge before store/IPC cleanup can throw and strand it.
    processor?.disposePendingSideEffectGauge()
    // Unhide before reveal remount registers handlers so main resumes delivery and emits its restore marker.
    releaseHiddenDeliveryClaim?.()
    unsubscribeByteParsers?.()
    unregisterFactConsumer?.()
    // Dispose old policy state before the revealed pane’s parsers take over.
    processor?.clearAccumulatedState()
    commandFinishedScanner?.reset()
    commandStatusPolicy.dispose()
    clearBellNotificationTimer()
    clearAgentTaskCompleteTimer()
    pendingBellNotification = false
    // Store merge cannot delete title slots; clear this watcher’s exact writes so stale working status cannot survive reveal.
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
