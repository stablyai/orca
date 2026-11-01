import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { requestTerminalWritePipelineProbe } from '@/lib/pane-manager/terminal-write-pipeline-health'
import { subscribeToTerminalUserInput } from '../terminal-user-input-signal'
import {
  isLocalNativeWindowsConpty,
  resolveWindowsShellOverride
} from '@/lib/pane-manager/windows-pty-compatibility'
import { createCommandCodeOutputStatusDetector } from '../../../../../shared/command-code-output-status'
import { readInFlightCommandCodeTurn } from '../parked-terminal-command-status'
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
  registerRendererOwnedAgentStatusPane,
  resolveRendererOwnedAgentStatusTiming
} from '../renderer-owned-agent-status-registry'

import { resolveLatestAgentDoneStartedAt } from './agent-done-started-at'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'
import {
  createTerminalInputEchoDelay,
  noteTerminalInputAwaitingEcho
} from './terminal-input-echo-delay'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPaneHostCapabilityFlags(session: ConnectPanePtySession): void {
  session.shellOverride = session.tab?.shellOverride
  // Why: a serve/remote-runtime pane has no SSH connectionId and a Linux cwd, so
  // the native-Windows ConPTY heuristic misfires on a Windows client and wrongly
  // enables ConPTY synchronized-output protection, which strips an agent's
  // transient cursor-show (?25h) and leaves the cursor invisible. The execution
  // host is the authoritative signal: only a 'local' host is a local native PTY.
  session.executionHostId = session.ownerContext.executionHostId
  session.isNativeWindowsConpty = isLocalNativeWindowsConpty({
    userAgent: navigator.userAgent,
    connectionId: null,
    cwd: session.deps.cwd,
    // Match main’s global-shell classification so default WSL never enables native ConPTY behavior.
    shellOverride: resolveWindowsShellOverride(
      session.shellOverride,
      session.state.settings?.terminalWindowsShell
    ),
    executionHostId: session.executionHostId
  })
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
      (session.paneStartup.launchAgent === 'codex' ||
        session.paneStartup.telemetry.agent_kind === 'codex')
    ) {
      // Completed Codex resumes can lack a done row; keep the Windows stale-focus guard until work resumes.
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
    !session.tab?.forceHostRuntime &&
    session.runtimeEnvironmentId === null &&
    (!session.ownerContext.selectedHost || session.ownerContext.projectRuntimeTarget)
      ? getLocalProjectExecutionRuntimeContext(
          session.state,
          session.deps.worktreeId,
          undefined,
          {
            wslAvailable: session.localWindowsTerminalCapabilities?.wslAvailable,
            availableWslDistros: session.localWindowsTerminalCapabilities?.wslDistros ?? null
          },
          session.ownerContext.projectRuntimeTarget
        )
      : undefined
  session.shouldOwnAgentStatusInRenderer = session.runtimeEnvironmentId !== null
  // Claim renderer-derived status once per transport so host mirroring cannot overwrite or delete its live row.
  session.releaseRendererOwnedAgentStatusPane =
    session.runtimeEnvironmentId !== null
      ? registerRendererOwnedAgentStatusPane(session.cacheKey, session.runtimeEnvironmentId)
      : null
  session.handleRendererOwnedAgentStatus = (payload): void => {
    const currentState = useAppStore.getState()
    const routing = session.resolveCurrentAgentStatusRouting()
    if (!routing) {
      return
    }
    const title = currentState.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
    const authoritativePaneAgent = session.getAuthoritativePaneAgent()
    const agentType = resolveCompatibleAgentTypeForOwner(payload.agentType, authoritativePaneAgent)
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
          agentType ?? authoritativePaneAgent
        )
      : resolvedStatusTitle
    // Only actual byte-derived status proves authority to fence out host mirroring.
    markRendererOwnedAgentStatusWrite(session.cacheKey)
    const timing = resolveRendererOwnedAgentStatusTiming(
      currentState.agentStatusByPaneKey[session.cacheKey]
    )
    if (session.launchToken) {
      currentState.setAgentStatus(
        session.cacheKey,
        observedStatusPayload,
        statusTitle,
        timing,
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
        timing,
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
  // Choose one side-effect consumer at transport creation; main facts replace title/bell/agent byte parsers.
  session.mainSideEffectAuthority = isMainTerminalSideEffectAuthorityForPty({
    settings: session.state.settings,
    runtimeEnvironmentId: session.runtimeEnvironmentId
  })
  // Choose hidden gating once under main authority so 2031 subscription facts and byte scans never both own the record.
  session.hiddenDeliveryGateActive =
    session.mainSideEffectAuthority &&
    isRendererHiddenPtyDeliveryGateEnabled(session.state.settings)
  // Share the structural gate predicate with subscription recording; a fact can outrun the hidden mark set by data delivery.
  session.isHiddenDeliveryGateManagedPty = (ptyId: string | null): ptyId is string =>
    session.hiddenDeliveryGateActive && Boolean(ptyId) && !isRemoteRuntimePtyId(ptyId)
  // Only byte mode runs Command Code scraping; main facts already drive seed/settle under main authority.
  session.commandCodeOutputStatusDetector = session.mainSideEffectAuthority
    ? null
    : createCommandCodeOutputStatusDetector({
        startupCommand: session.paneStartup?.command,
        // Seed in-flight Command Code turns on reveal; recreated detectors missed the banner and must still recognize idle return.
        inFlightTurn: readInFlightCommandCodeTurn(session.cacheKey),
        onWorking: session.seedCommandCodeOutputWorkingStatus,
        onDone: session.scheduleCommandCodeOutputDoneStatus
      })
  session.shouldDeliverStartupViaTerminalPaste = session.paneStartup?.delivery === 'terminal-paste'
  session.hadExistingPaneTransportAtConnect = session.deps.paneTransportsRef.current.size > 0
  session.lastTerminalInputAt = Number.NEGATIVE_INFINITY
  session.lastInteractiveRedrawInputAt = Number.NEGATIVE_INFINITY
  session.inputEchoDelay = createTerminalInputEchoDelay()
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
    noteTerminalInputAwaitingEcho(session.inputEchoDelay, session.lastInteractiveRedrawInputAt)
    if (session.synchronizedForegroundOutputActive) {
      session.synchronizedForegroundFrameInteractive = true
      session.synchronizedForegroundInteractivePresentPending = true
    }
    // Why: input must probe a wedged xterm even when the PTY produces no renderer output.
    requestTerminalWritePipelineProbe(session.pane.terminal)
  }
  session.recordTerminalInputForHibernation = (): void => {
    useAppStore.getState().recordTerminalInput(session.cacheKey)
  }
  // Record real input from xterm’s core signal; onData also carries query replies that falsely prevent hibernation. Fall back only if that signal is absent.
  session.recordRealUserTerminalInput = (): void => {
    session.recordTerminalInputForHibernation()
  }
  // Why: xterm fires onUserInput before onData, so publishing here made the key wait on every store subscriber before reaching the PTY.
  session.userInputActivityDisposable = subscribeToTerminalUserInput(session.pane.terminal, () =>
    queueMicrotask(() => {
      if (!session.disposed) {
        session.recordRealUserTerminalInput()
      }
    })
  )
  session.recordTerminalInputForHibernationFallback = (): void => {
    if (session.userInputActivityDisposable === null) {
      session.recordTerminalInputForHibernation()
    }
  }
}
