import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { isMainTerminalSideEffectAuthorityForPty } from '../pty-transport/output/terminal-side-effect-facts-handler'
import { isRendererHiddenPtyDeliveryGateEnabled } from '../pty-transport/delivery/terminal-hidden-delivery-gate'
import { installPtyKittyFileReader } from './host-ownership/pty-kitty-file-reader'
import { installSpawnDeferredSleep } from './spawn/spawn-deferred-sleep'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { useAppStore } from '@/store'
import { createPaneWindowsPtyModel } from './geometry/pane-windows-pty-model'
import { buildTerminalKeyboardProtocolOptions } from '@/lib/pane-manager/terminal-protocol/terminal-keyboard-protocol'
import { resolvePaneKeyboardProtocolAgent } from '../input/keyboard/terminal-keyboard-protocol-pane-agent'
import { TerminalKittyKeyboardModeTracker } from '../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import type { PtyConnectionDeps } from './pty-connection-deps'
import { registerTerminalPaneRecoveryInstance } from '../render-health/recovery/terminal-pane-recovery'
import { captureTabRecoveryGeneration } from '@/store/terminals/pty/terminal-tab-recovery-ledger'
import { TerminalIdleCursorReset } from '../emulation/terminal-idle-cursor-reset'
import { TerminalStreamPosition } from '../pty-transport/delivery/terminal-stream-position'
import { writeTerminalOutput } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'
import { createTerminalStructuralReplayCoordinator } from '@/lib/pane-manager/terminal-replay/terminal-structural-replay-coordinator'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { resolveExplicitTerminalTitleAgentType } from '../../../../../shared/agent-status/title/terminal-title-agent-type'

import { shouldWritePtyOutputForeground } from './output/foreground-output-visibility'
import { exposeE2eTerminalPtyOutputDebug } from './instrumentation/e2e-terminal-pty-harness'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import {
  isAgentTaskCompleteNotificationEnabled,
  isAgentTaskCompleteTrackingEnabled
} from './notifications/agent-task-complete-settings'

import { installRunDeferredConnect } from './run-deferred-connect'

import { installSleepingRecordAccess } from './startup/sleeping-record-access'
import { installShellCommandInference } from './agent-identity/shell-command-inference'
import { installInterruptInputIntent } from './agent-identity/interrupt-input-intent'
import { installTerminalKeydownIntent } from './input/terminal-keydown-intent'
import { bindPanePtyFit, bindPanePtyFitRelease } from './geometry/pane-pty-fit-binding'
import { bindPaneSideEffectFacts } from './output/pane-side-effect-facts'

import { installPaneAgentCompletion } from './agent-identity/pane-agent-completion'
import { installTerminalLaunchInputAttempt } from './startup/terminal-launch-input-attempt'
import { bindPaneAgentStatusRouting } from './agent-identity/pane-agent-status-routing'
import { initializePanePtyExit, bindPanePtyExit } from './lifecycle/pane-pty-exit'
import { installHibernatedPaneWake } from './lifecycle/hibernated-pane-wake'

import { installPaneTitleObservation } from './agent-identity/pane-title-observation'
import { bindInitialAgentStatus } from './startup/initial-agent-status'
import { bindCommandCodeOutputStatus } from './agent-identity/command-code-pane-status'
import { installActivePanePtyBinding } from './lifecycle/active-pane-pty-binding'
import { installTerminalBellCompletionArbitration } from './notifications/terminal-bell-completion-arbitration'
import { installAgentTaskCompleteNotify } from './notifications/agent-task-complete-notify'
import { installPaneAgentTitleLifecycle } from './agent-identity/pane-agent-title-lifecycle'
import { initializePaneConnectionContext } from './pane-connection-context'
import { installNativeWindowsPanePolicy } from './emulation/native-windows-pane-policy'
import { bindPaneProjectRuntime } from './host-ownership/pane-project-runtime'
import { installRendererOwnedPaneStatus } from './agent-identity/renderer-owned-pane-status'
import { installCommandCodeOutputStatusDetector } from './agent-identity/command-code-output-status'
import {
  initializeTerminalInputActivityState,
  installTerminalInputActivity,
  bindAcceptedTerminalInputActivity
} from './input/terminal-input-activity'

import { installPaneTransport } from './host-ownership/pane-transport-bootstrap'
import {
  bindDesktopCapabilityReplyGate,
  installPaneCapabilityReplies
} from './emulation/pane-capability-replies'
import { bindHiddenPaneMode2031Facts } from './emulation/pane-mode-2031-state'

import { installPaneViewportClaim } from './geometry/pane-viewport-claim'
import { installPtyInputRecovery } from './lifecycle/pty-input-recovery'
import { installAgentPreReadyTypedDraft } from './startup/agent-pre-ready-typed-draft'
import { installPtyInputForward } from './input/pty-input-forward'
import { installPtyResizeForward } from './geometry/pty-resize-forward'
import { installPtyResizeGeometry } from './geometry/pty-resize-geometry'
import { type PanePtyBinding, createPanePtyBinding } from './pane-pty-binding'
import { findTerminalTabForPane } from './terminal-tab-id'

export function connectPanePty(
  pane: ManagedPane,
  manager: PaneManager,
  deps: PtyConnectionDeps
): PanePtyBinding {
  const session = { pane, manager, deps } as ConnectPanePtySession
  session.shouldRefreshForegroundSynchronously = (): boolean =>
    !session.manager.hasWebglRenderer(session.pane.id)
  // Resolve both remount and recovery epochs from one row to avoid a second global tab scan.
  const terminalTab = findTerminalTabForPane(useAppStore.getState(), deps.worktreeId, deps.tabId)
  session.tabGeneration = terminalTab?.generation ?? 0
  // Recovery belongs to this xterm instance; late requests cannot replace its already-remounted successor.
  session.terminalRecoveryGeneration = captureTabRecoveryGeneration(terminalTab)
  session.terminalRecoveryInstance = registerTerminalPaneRecoveryInstance(session.deps.tabId)
  session.mountFollowsTerminalPark = session.deps.mountFollowsTerminalPark
  session.authoritativeReattachGeneration = 0
  exposeE2eTerminalPtyOutputDebug()
  session.disposed = false
  session.structuralReplayCoordinator = createTerminalStructuralReplayCoordinator(
    session.pane.terminal
  )
  session.connectFrame = null
  session.connectFallbackTimer = null
  session.connectStarted = false
  session.unregisterBacklogRecovery = null
  session.unregisterDocumentVisibilityRecovery = null
  session.cancelHiddenOutputSnapshotScrollRestore = (): void => {}
  session.pendingHiddenSnapshotFit = null
  session.pendingReattachFit = null
  session.cancelFreshSpawnFollowReset = (): void => {}
  session.cleanupHiddenOutputRestoreDeferredRetry = (): void => {}
  session.cleanupHiddenOutputRestoreForegroundDeadline = (): void => {}
  session.cleanupHiddenOutputRestoreFloodRepaint = (): void => {}
  session.flushRemoteProgramRedraw = (): void => {}
  session.resetRendererOrderedSeqForPtyExit = () => {}
  session.cleanupStartupDraftPasteTimers = (): void => {}
  session.unregisterE2ePtyDataInjection = (): void => {}
  session.startupInjectTimer = null
  session.agentTaskCompleteNotificationGraceTimer = null
  session.agentTaskCompleteNotificationMaxTimer = null
  session.hookOwnedIdleAbsorbsBell = false
  session.agentTaskCompleteStatusUnsubscribe = null
  session.agentTaskCompleteSettingsUnsubscribe = null
  session.agentTaskCompleteNotificationGeneration = 0
  session.wasAgentTaskCompleteTrackingEnabled = isAgentTaskCompleteTrackingEnabled()
  session.requiresFreshWorkingForAgentTaskCompleteNotification =
    !session.wasAgentTaskCompleteTrackingEnabled
  session.wasAgentTaskCompleteOsNotificationEnabled = isAgentTaskCompleteNotificationEnabled()
  session.terminalBellNotificationTimer = null
  session.pendingTerminalBellNotification = false
  session.reattachIdleAgentCursorResetTimer = null
  session.shiftEnterReconfirmTimer = null
  session.synchronizedForegroundOutputActive = false
  // Why: carries up to one marker-length-1 of trailing bytes so a ConPTY-split DEC 2026 marker is still detected (#8754).
  session.synchronizedForegroundMarkerTail = ''
  // Classify latency at frame open so ConPTY-split closing markers retain the fast drain after the keystroke window.
  session.synchronizedForegroundFrameInteractive = false
  session.synchronizedForegroundInteractivePresentPending = false
  session.suppressStructuralReplayPtyResize = false
  // Lifecycle can precede deferred output setup; initialize hidden-delivery callbacks as no-ops.
  session.syncHiddenRendererPtyDelivery = () => {}
  session.releaseHiddenRendererPtyDelivery = () => {}
  session.handleRemoteOutputPauseChanged = () => {}
  session.handleRemotePausedOutputDropped = () => {}
  session.handleRendererOwnedAgentStatus = () => {}
  session.remoteOutputGatedPtyId = null
  session.remoteOutputFactConsumerPtyId = null
  session.suppressViewportClaimTerminalResize = false
  session.suppressNativeWindowsIdleCodexFocusReports = false
  session.setFocusReportSuppressionForAgentCompletion = (
    title: string | undefined,
    agentType: AgentType | undefined
  ): void => {
    const titleAgentType = resolveExplicitTerminalTitleAgentType(title ?? '')
    session.suppressNativeWindowsIdleCodexFocusReports =
      agentType && agentType !== 'unknown' ? agentType === 'codex' : titleAgentType === 'codex'
  }
  // Idle callbacks precede deferred setup; switch from the shared scheduler to the PTY writer to preserve hidden-byte ordering and recovery.
  session.idleCursorReset = new TerminalIdleCursorReset()
  session.streamPosition = new TerminalStreamPosition()
  session.skippedQueryCarry = null
  session.queueAgentIdleTerminalModeReset = (): void => {
    if (session.disposed) {
      return
    }
    const reset = session.idleCursorReset.request()
    if (reset) {
      writeTerminalOutput(session.pane.terminal, reset, {
        foreground: shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
      })
    }
  }
  // Dispose actively unsubscribes and resolves passphrase waits; disconnected stores may never emit to release them.
  session.waitTeardowns = []
  // Consume startup once from this shallow-copied deps; callers must clear their separate outer reference.
  session.paneStartup = session.deps.startup ?? null
  if (session.paneStartup?.resumeOrigin === 'saved') {
    session.paneStartup.resumeSource ??= { cancelled: false }
  }
  session.deps.startup = undefined
  // Hold replacement PTY retirement until main takes it in a spawn request or disposal kills it.
  session.pendingReplacedPtyId = session.deps.replacesPtyId ?? null
  // Why: the first spawn claims the PTY, but a deferred retry is still the same user restart.
  session.userRestart =
    Boolean(session.deps.accountRestartToken) || session.pendingReplacedPtyId !== null
  session.deps.replacesPtyId = undefined
  session.claimPendingReplacedPtyId = (): string | null => {
    const ptyId: string | null = session.pendingReplacedPtyId
    session.pendingReplacedPtyId = null
    return ptyId
  }

  // Use stable leaf UUIDs for keys crossing env, hook IPC and replay; numeric pane IDs are renderer-local.
  session.cacheKey = makePaneKey(session.deps.tabId, session.pane.leafId)
  installSleepingRecordAccess(session)
  installShellCommandInference(session)
  installInterruptInputIntent(session)
  installTerminalKeydownIntent(session)
  bindPanePtyFit(session)
  bindPaneSideEffectFacts(session)
  bindPanePtyFitRelease(session)
  installPaneAgentCompletion(session)

  installTerminalLaunchInputAttempt(session)
  initializePanePtyExit(session)
  installHibernatedPaneWake(session)
  bindPanePtyExit(session)

  // Seed idle cache timing only on reattach; already-idle restored Claude emits no transition, while fresh idle launches have no prompt cache.
  session.hasConsideredInitialCacheTimerSeed = false
  session.allowInitialIdleCacheSeed = false
  bindPaneAgentStatusRouting(session)
  installSpawnDeferredSleep(session)
  installPaneTitleObservation(session)
  bindInitialAgentStatus(session)
  bindCommandCodeOutputStatus(session)

  installActivePanePtyBinding(session)
  installTerminalBellCompletionArbitration(session)
  installAgentTaskCompleteNotify(session)
  installPaneAgentTitleLifecycle(session)
  initializePaneConnectionContext(session)
  session.windowsPtyModel = createPaneWindowsPtyModel(() => ({
    terminal: session.pane.terminal,
    owner: session.ownerContext,
    transport: session.transport ?? null
  }))
  const backendContext = {
    userAgent: navigator.userAgent,
    osRelease: window.api.platform?.get?.()?.osRelease,
    connectionId: session.ownerContext.connectionId,
    cwd: session.deps.cwd,
    shellOverride: session.tab?.shellOverride,
    executionHostId: session.ownerContext.executionHostId,
    tuiAgent: resolvePaneKeyboardProtocolAgent(session.paneStartup, session.tab?.launchAgent)
  }
  // Capture backend policy before the tracker and transport copy xterm's initial capability flags.
  const keyboardProtocol = buildTerminalKeyboardProtocolOptions(backendContext)
  session.windowsPtyModel.apply()
  Object.assign(
    session.pane.terminal.options,
    keyboardProtocol,
    // Merge: replacing vtExtensions would re-enable xterm's own mode-2031 reports.
    keyboardProtocol.vtExtensions
      ? {
          vtExtensions: {
            ...session.pane.terminal.options.vtExtensions,
            ...keyboardProtocol.vtExtensions
          }
        }
      : {}
  )
  // xterm exposes no Kitty read; mirror the flags its encoder applies.
  session.kittyKeyboardModes = (() => {
    const existing = session.deps.paneKittyKeyboardModesRef.current.get(session.pane.id)
    if (existing) {
      return existing
    }
    const created = new TerminalKittyKeyboardModeTracker({
      kittyKeyboard: session.pane.terminal.options.vtExtensions?.kittyKeyboard === true
    })
    session.deps.paneKittyKeyboardModesRef.current.set(session.pane.id, created)
    return created
  })()

  bindPaneProjectRuntime(session)
  // Why: a serve/remote-runtime pane has no SSH connectionId and a Linux cwd, so
  // the native-Windows ConPTY heuristic misfires on a Windows client and wrongly
  // enables ConPTY synchronized-output protection, which strips an agent's
  // transient cursor-show (?25h) and leaves the cursor invisible. The execution
  // host is the authoritative signal: only a 'local' host is a local native PTY.
  session.executionHostId = session.ownerContext.executionHostId
  installNativeWindowsPanePolicy(session)
  installRendererOwnedPaneStatus(session)

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
  installCommandCodeOutputStatusDetector(session)

  session.shouldDeliverStartupViaTerminalPaste = session.paneStartup?.delivery === 'terminal-paste'
  session.hadExistingPaneTransportAtConnect = session.deps.paneTransportsRef.current.size > 0
  initializeTerminalInputActivityState(session)

  session.hasReceivedPtyOutput = false
  session.deferredReattachLiveData = null
  session.reattachLiveDataDeferralDepth = 0
  session.deferredReattachLiveDataOwners = new Map<number, { failed: boolean }>()
  session.transportStreamGeneration = 0
  installTerminalInputActivity(session)
  bindAcceptedTerminalInputActivity(session)
  installPaneTransport(session)
  bindDesktopCapabilityReplyGate(session)
  bindHiddenPaneMode2031Facts(session)

  session.deps.paneTransportsRef.current.set(session.pane.id, session.transport)
  installPaneCapabilityReplies(session)
  installPaneViewportClaim(session)
  installPtyInputRecovery(session)
  installAgentPreReadyTypedDraft(session)
  // Async callbacks may outlive PaneManager; use durable leaf identity and require current transport ownership.
  const isCurrentPaneTransport = (): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
  session.syncPanePtyLayoutBinding = (ptyId: string | null): void => {
    if (!isCurrentPaneTransport()) {
      return
    }
    if (session.deps.syncPanePtyLayoutBindingForLeaf) {
      session.deps.syncPanePtyLayoutBindingForLeaf(session.pane.leafId, ptyId, session.pane.id)
      return
    }
    session.deps.syncPanePtyLayoutBinding(session.pane.id, ptyId)
  }
  session.clearExitedPanePtyLayoutBinding = (exitedPtyId: string): void => {
    if (!isCurrentPaneTransport()) {
      return
    }
    if (session.deps.clearExitedPanePtyLayoutBindingForLeaf) {
      session.deps.clearExitedPanePtyLayoutBindingForLeaf(session.pane.leafId, exitedPtyId)
      return
    }
    session.deps.clearExitedPanePtyLayoutBinding(session.pane.id, exitedPtyId)
  }
  installPtyKittyFileReader(session)
  installPtyInputForward(session)
  installPtyResizeForward(session)
  installPtyResizeGeometry(session)
  installRunDeferredConnect(session)
  return createPanePtyBinding(session)
}
