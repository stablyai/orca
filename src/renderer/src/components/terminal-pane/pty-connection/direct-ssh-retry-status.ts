import { reportWorkerTerminalUserInput } from '@/lib/worker-terminal-takeover-report'
import { resolvePaneOwnerBaseAgent } from '@/lib/agent-base-identity'
import { useAppStore } from '@/store'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { requestTerminalWritePipelineProbe } from '@/lib/pane-manager/terminal-write-pipeline-health'
import {
  RESET_KITTY_KEYBOARD_PROTOCOL,
  RESET_TERMINAL_CURSOR_STYLE
} from '../../../../../shared/terminal-mode-reset-profiles'
import { subscribeToTerminalUserInput } from '../terminal-user-input-signal'
import {
  isLocalNativeWindowsConpty,
  resolveWindowsShellOverride
} from '@/lib/pane-manager/windows-pty-compatibility'
import { shouldSuppressCodexAutoApprovalStatus } from '../codex-auto-approval-notification-suppression'
import { createCommandCodeOutputStatusDetector } from '../../../../../shared/command-code-output-status'
import { readInFlightCommandCodeTurn } from '../parked-terminal-command-status'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status-terminal-title'
import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from '../../../../../shared/agent-title-owner'
import { isMainTerminalSideEffectAuthorityForPty } from '../terminal-side-effect-facts-handler'
import { isRendererHiddenPtyDeliveryGateEnabled } from '../terminal-hidden-delivery-gate'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane
} from '../renderer-owned-agent-status-registry'

import { DIRECT_SSH_PANE_RETRY_SETTLEMENT_TIMEOUT_MS } from './pty-connect-limits'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { resolveLatestAgentDoneStartedAt } from './agent-done-started-at'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { DirectSshRetryLease } from './direct-ssh-retry-lease'

/** Direct-SSH retry arming plus the host/Windows capability flags and input-activity tracking its status routing reads. */
export function installDirectSshRetryStatus(session: ConnectPanePtySession): void {
  session.armDirectSshPaneRetryTimeout = (
    promise: Promise<unknown>,
    attempt: DirectSshRetryLease | undefined
  ): void => {
    if (!attempt || session.disposed || session.directSshPaneRetryTimedPromises.has(promise)) {
      return
    }
    session.directSshPaneRetryTimedPromises.add(promise)
    const timer = setTimeout(() => {
      session.directSshPaneRetrySettlementTimers.delete(timer)
      if (session.directSshPaneRetrySettlementCancelled) {
        return
      }
      session.settleDirectSshPaneRetryAttempt(attempt, 'timed-out')
    }, DIRECT_SSH_PANE_RETRY_SETTLEMENT_TIMEOUT_MS)
    session.directSshPaneRetrySettlementTimers.add(timer)
    void promise
      .finally(() => {
        session.directSshPaneRetrySettlementTimers.delete(timer)
        clearTimeout(timer)
      })
      .catch(() => {})
  }
  session.shellOverride = session.tab?.shellOverride
  // Why: a serve/remote-runtime pane has no SSH connectionId and a Linux cwd, so
  // the native-Windows ConPTY heuristic misfires on a Windows client and wrongly
  // enables ConPTY synchronized-output protection, which strips an agent's
  // transient cursor-show (?25h) and leaves the cursor invisible. The execution
  // host is the authoritative signal: only a 'local' host is a local native PTY.
  session.executionHostId = session.terminalOwnerUnresolved
    ? ('runtime:unresolved-owner' as const)
    : getExecutionHostIdForWorktree(session.state, session.deps.worktreeId)
  session.isNativeWindowsConpty = isLocalNativeWindowsConpty({
    userAgent: navigator.userAgent,
    connectionId: session.connectionId,
    cwd: session.deps.cwd,
    // Why: main folds the global Windows shell into its spawn classification
    // (pty.ts effectiveShellOverride); fold it here too so both sides treat
    // a global-WSL default identically (terminal-query-authority.md ConPTY).
    shellOverride: resolveWindowsShellOverride(
      session.shellOverride,
      session.state.settings?.terminalWindowsShell
    ),
    executionHostId: session.executionHostId
  })
  if (session.isNativeWindowsConpty) {
    // Why: Windows ConPTY agent turns can leave renderer keyboard modes armed
    // after completion, corrupting plain input with encoded bytes.
    session.idleAgentTerminalModeReset = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`
  }
  session.shouldApplyNativeWindowsRewriteRefresh = session.isNativeWindowsConpty
  session.shouldApplyWindowsRendererUnicodeRefresh = CLIENT_PLATFORM === 'win32'
  session.shouldProtectNativeWindowsSynchronizedOutput = session.isNativeWindowsConpty
  session.unsubscribeWindowsDoneTerminalModeReset = null
  if (session.isNativeWindowsConpty) {
    const initialAgentStatus = session.state.agentStatusByPaneKey[session.cacheKey]
    let lastAgentDoneStartedAt = resolveLatestAgentDoneStartedAt(initialAgentStatus)
    if (
      !initialAgentStatus &&
      session.paneStartup?.telemetry?.launch_source === 'sidebar' &&
      session.paneStartup.telemetry.request_kind === 'resume' &&
      (resolvePaneOwnerBaseAgent(session.paneStartup.launchAgent) === 'codex' ||
        session.paneStartup.telemetry.agent_kind === 'codex')
    ) {
      // Why: history resumes open on a completed Codex composer without a done
      // row, so arm the same Windows stale-focus guard until work starts again.
      session.suppressNativeWindowsIdleCodexFocusReports = true
    }
    if (initialAgentStatus?.state === 'done') {
      session.setFocusReportSuppressionForAgentCompletion(undefined, initialAgentStatus.agentType)
    }
    session.unsubscribeWindowsDoneTerminalModeReset = useAppStore.subscribe((nextState) => {
      const nextAgentStatus = nextState.agentStatusByPaneKey[session.cacheKey]
      const nextAgentStatusState = nextAgentStatus?.state
      if (nextAgentStatusState === 'done') {
        session.setFocusReportSuppressionForAgentCompletion(undefined, nextAgentStatus.agentType)
      } else if (nextAgentStatusState) {
        session.suppressNativeWindowsIdleCodexFocusReports = false
      }
      const nextAgentDoneStartedAt = resolveLatestAgentDoneStartedAt(nextAgentStatus)
      // Why: a NEW completed turn — same-state `done` pings keep stateStartedAt, so they no-op.
      if (
        nextAgentDoneStartedAt !== undefined &&
        nextAgentDoneStartedAt !== lastAgentDoneStartedAt
      ) {
        session.queueAgentIdleTerminalModeReset()
      }
      lastAgentDoneStartedAt = nextAgentDoneStartedAt
    })
  }

  session.localWindowsTerminalCapabilities = hasCachedWindowsTerminalCapabilities()
    ? getCachedWindowsTerminalCapabilities()
    : null
  session.projectRuntime =
    !session.tab?.forceHostRuntime && !session.connectionId && session.runtimeEnvironmentId === null
      ? getLocalProjectExecutionRuntimeContext(session.state, session.deps.worktreeId, undefined, {
          wslAvailable: session.localWindowsTerminalCapabilities?.wslAvailable,
          availableWslDistros: session.localWindowsTerminalCapabilities?.wslDistros ?? null
        })
      : undefined
  session.shouldOwnAgentStatusInRenderer = session.runtimeEnvironmentId !== null
  // Why: the host also mirrors agent status for this pane through tabs.
  // Claiming here (decided once at transport creation, like the side-effect
  // authority below) lets the mirror keep this renderer's byte-derived status
  // instead of overwriting/deleting it on every republication.
  session.releaseRendererOwnedAgentStatusPane =
    session.runtimeEnvironmentId !== null
      ? registerRendererOwnedAgentStatusPane(session.cacheKey, session.runtimeEnvironmentId)
      : null
  session.handleRendererOwnedAgentStatus = (payload): void => {
    if (
      shouldSuppressCodexAutoApprovalStatus(payload, {
        paneKey: session.cacheKey,
        tabId: session.deps.tabId,
        ...(session.launchToken ? { launchToken: session.launchToken } : {})
      })
    ) {
      return
    }
    const currentState = useAppStore.getState()
    const routing = session.resolveCurrentAgentStatusRouting()
    if (!routing) {
      return
    }
    const title = currentState.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
    const authoritativePaneAgent = session.getAuthoritativePaneAgent()
    const authoritativePaneBaseAgent = resolvePaneOwnerBaseAgent(authoritativePaneAgent)
    const agentType = resolveCompatibleAgentTypeForOwner(
      payload.agentType,
      authoritativePaneBaseAgent
    )
    const statusPayload = agentType === payload.agentType ? payload : { ...payload, agentType }
    const observedStatusPayload = {
      ...statusPayload,
      observation: rendererAgentStatusObservations.observe(session.cacheKey, {
        origin: 'osc',
        observedAt: Date.now(),
        kind: 'snapshot'
      })
    }
    const resolvedStatusTitle = resolveAgentStatusTerminalTitle(statusPayload, title)
    const statusTitle = resolvedStatusTitle
      ? normalizeCompatibleAgentTitleForOwner(
          resolvedStatusTitle,
          agentType ?? authoritativePaneBaseAgent
        )
      : resolvedStatusTitle
    // Why: proves the claim — only a pane that really produced byte-derived
    // status may fence the host mirror out of its store key.
    markRendererOwnedAgentStatusWrite(session.cacheKey)
    if (session.launchToken) {
      currentState.setAgentStatus(
        session.cacheKey,
        observedStatusPayload,
        statusTitle,
        undefined,
        routing,
        {
          launchToken: session.launchToken
        }
      )
    } else {
      currentState.setAgentStatus(
        session.cacheKey,
        observedStatusPayload,
        statusTitle,
        undefined,
        routing
      )
    }
    if (payload.state === 'working' && session.syncAgentTaskCompleteTrackingEnabled()) {
      session.requiresFreshWorkingForAgentTaskCompleteNotification = false
    }
    const storedStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    const notificationPayload =
      typeof storedStatus?.stateStartedAt === 'number'
        ? { ...statusPayload, stateStartedAt: storedStatus.stateStartedAt }
        : statusPayload
    // Why: hook lifecycle owns deferred side effects even when alerts are disabled.
    session.agentCompletionCoordinator.observeHookStatus(notificationPayload)
    if (payload.state === 'working' && session.pendingTerminalBellNotification) {
      session.scheduleTerminalBellNotification()
    }
  }
  // Why: when main holds side-effect authority for this PTY's bytes, the
  // transport must NOT register title/bell/agent byte parsers — the
  // pty:sideEffect fact consumer below is the single policy consumer.
  // Decided once at transport creation so a fact never has two consumers.
  session.mainSideEffectAuthority = isMainTerminalSideEffectAuthorityForPty({
    settings: session.state.settings,
    runtimeEnvironmentId: session.runtimeEnvironmentId
  })
  // Why: Phase-4 hidden-delivery gate — only meaningful under main authority
  // (renderer byte parsers need bytes otherwise). Decided once at pane
  // creation: it picks which path records a mode-2031 subscription (main's
  // fact vs the byte scan), which must have exactly one owner.
  session.hiddenDeliveryGateActive =
    session.mainSideEffectAuthority &&
    isRendererHiddenPtyDeliveryGateEnabled(session.state.settings)
  // Why: structural per-PTY gate predicate (authority on + gate on + bytes
  // transit local main, which implies snapshot-backed). Shared by the hidden
  // mark sync and mode-2031 subscription recording so the recorder can never
  // disagree with what main may drop — and never depends on the racy hidden
  // mark (a fact can outrun the pty:data task that sets it).
  session.isHiddenDeliveryGateManagedPty = (ptyId: string | null): ptyId is string =>
    session.hiddenDeliveryGateActive && Boolean(ptyId) && !isRemoteRuntimePtyId(ptyId)
  // Why (byte-parser mode only): with main authority the Command Code scrape
  // runs in main's per-PTY tracker and arrives as command-code facts; running
  // the byte detector too would double-drive the seed/settle policy above.
  session.commandCodeOutputStatusDetector = session.mainSideEffectAuthority
    ? null
    : createCommandCodeOutputStatusDetector({
        startupCommand: session.paneStartup?.command,
        // Why the seed: a reveal remount recreates this detector long past the banner
        // (and with no startup command); a turn parked mid-flight must still arm the
        // scrape so its return to the idle composer completes the row.
        inFlightTurn: readInFlightCommandCodeTurn(session.cacheKey),
        onWorking: session.seedCommandCodeOutputWorkingStatus,
        onDone: session.scheduleCommandCodeOutputDoneStatus
      })
  session.shouldDeliverStartupViaTerminalPaste = session.paneStartup?.delivery === 'terminal-paste'
  session.shouldUseProviderSshStartupDelivery =
    Boolean(session.connectionId) && !session.shouldDeliverStartupViaTerminalPaste
  session.hadExistingPaneTransportAtConnect = session.deps.paneTransportsRef.current.size > 0
  session.lastTerminalInputAt = Number.NEGATIVE_INFINITY
  session.lastInteractiveRedrawInputAt = Number.NEGATIVE_INFINITY
  session.hasReceivedPtyOutput = false
  session.deferredReattachLiveData = null
  session.reattachLiveDataDeferralDepth = 0
  session.deferredReattachLiveDataOwners = new Map<number, { failed: boolean }>()
  session.transportStreamGeneration = 0
  session.markTerminalInputSent = (): void => {
    session.lastTerminalInputAt = performance.now()
    session.markInteractiveRedrawInput()
  }
  session.markInteractiveRedrawInput = (): void => {
    session.lastInteractiveRedrawInputAt = performance.now()
    // Why: input must probe a wedged xterm even when the PTY produces no renderer output.
    requestTerminalWritePipelineProbe(session.pane.terminal)
  }
  session.recordTerminalInputForHibernation = (): void => {
    useAppStore.getState().recordTerminalInput(session.cacheKey)
  }
  // Why: onData mixes real user input with xterm's parser auto-replies (focus
  // reports, DA/DSR/CPR responses). Recording those replies as activity makes
  // the hibernation planner treat a pane hidden after its agent finished as
  // "input after done" forever. The core user-input signal fires only for real
  // input, so hibernation activity records from it; onData recording remains
  // solely as the fallback when the internal API is unavailable.
  session.recordRealUserTerminalInput = (): void => {
    session.recordTerminalInputForHibernation()
    // Takeover must never fire from the onData fallback below: it mixes in auto-replies.
    reportWorkerTerminalUserInput(session.cacheKey, session.runtimeEnvironmentId)
  }
  session.userInputActivityDisposable = subscribeToTerminalUserInput(
    session.pane.terminal,
    session.recordRealUserTerminalInput
  )
  session.recordTerminalInputForHibernationFallback = (): void => {
    if (session.userInputActivityDisposable === null) {
      session.recordTerminalInputForHibernation()
    }
  }
}
