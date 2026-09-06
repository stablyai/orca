import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { TerminalKittyKeyboardModeTracker } from '../../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { PtyConnectionDeps } from '../pty-connection-types'
import {
  captureTerminalPaneRecoveryGeneration,
  registerTerminalPaneRecoveryInstance
} from '../terminal-pane-recovery'
import { RESET_TERMINAL_CURSOR_STYLE } from '../../../../../shared/terminal-mode-reset-profiles'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { createTerminalStructuralReplayCoordinator } from '@/lib/pane-manager/terminal-structural-replay-coordinator'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'

import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { exposeE2eTerminalPtyOutputDebug } from './e2e-terminal-pty-harness'
import type { PanePtyBinding } from './pane-pty-binding'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import {
  isAgentTaskCompleteNotificationEnabled,
  isAgentTaskCompleteTrackingEnabled
} from './agent-task-complete-settings'

import { installRunDeferredConnect } from './run-deferred-connect'

import { installSleepingRecordAccess } from './sleeping-record-access'
import { installShellCommandInference } from './shell-command-inference'
import { installInterruptInputIntent } from './interrupt-input-intent'
import { installTerminalKeydownFit } from './terminal-keydown-fit'
import { installPtyExitHibernate } from './pty-exit-hibernate'
import { installTitleSpawnBell } from './title-spawn-bell'
import { installAgentTaskCompleteNotify } from './agent-task-complete-notify'
import { installDirectSshRetryStatus } from './direct-ssh-retry-status'
import { installPtyInputRecovery } from './pty-input-recovery'
import { installPtyInputForward } from './pty-input-forward'
import { installPtyResizeGeometry } from './pty-resize-geometry'
import { installSessionReconcileDispose } from './session-reconcile-dispose'
import { resolveTerminalTabId } from './terminal-tab-id'

/**
 * Establishes a binding between a terminal pane and its corresponding PTY stream,
 * managing input, output, title synchronization, and agent status tracking.
 */
export function connectPanePty(
  pane: ManagedPane,
  manager: PaneManager,
  deps: PtyConnectionDeps
): PanePtyBinding {
  const session = { pane, manager, deps } as ConnectPanePtySession
  session.shouldRefreshForegroundSynchronously = (): boolean =>
    !session.manager.hasWebglRenderer(session.pane.id)
  const state = useAppStore.getState()
  const unifiedTab = state.getTab?.(deps.tabId)
  const initialOwnerWorktreeId =
    state.getTerminalTabOwnerWorktreeId?.(deps.tabId) ??
    (unifiedTab?.contentType === 'terminal'
      ? state.getTerminalTabOwnerWorktreeId?.(unifiedTab.entityId)
      : null)
  const terminalTabId = resolveTerminalTabId(
    {
      getTab: state.getTab,
      hasTerminalTab: (candidateId) =>
        Boolean(
          state.tabsByWorktree[deps.worktreeId]?.some(
            (candidate) => candidate.id === candidateId
          ) ||
          (initialOwnerWorktreeId
            ? state.tabsByWorktree[initialOwnerWorktreeId]?.some(
                (candidate) => candidate.id === candidateId
              )
            : false)
        )
    },
    deps.tabId
  )
  const ownerWorktreeId =
    state.getTerminalTabOwnerWorktreeId?.(terminalTabId) ?? initialOwnerWorktreeId
  const terminalTab =
    state.tabsByWorktree[deps.worktreeId]?.find((candidate) => candidate.id === terminalTabId) ??
    (ownerWorktreeId
      ? state.tabsByWorktree[ownerWorktreeId]?.find((candidate) => candidate.id === terminalTabId)
      : undefined) ??
    // Why: folder/worktree migrations can leave the pane's render key stale for one commit.
    Object.values(state.tabsByWorktree)
      .find((tabs) => tabs.some((candidate) => candidate.id === terminalTabId))
      ?.find((candidate) => candidate.id === terminalTabId)
  const tab = terminalTab ?? (unifiedTab && 'generation' in unifiedTab ? unifiedTab : null)
  session.tabGeneration = tab?.generation ?? 0
  // Why: recovery ownership belongs to this xterm instance. A request that
  // settles after remount must not remount its already-replaced successor.
  session.terminalRecoveryGeneration = captureTerminalPaneRecoveryGeneration(session.deps.tabId)
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
  session.startupGridSettleHandle = null
  session.startupGridSettledForConnect = false
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
  session.resetRendererOrderedSeqForPtyExit = () => {}
  session.cleanupStartupDraftPasteTimers = (): void => {}
  session.unregisterE2ePtyDataInjection = (): void => {}
  session.startupInjectTimer = null
  session.agentTaskCompleteNotificationGraceTimer = null
  session.agentTaskCompleteNotificationMaxTimer = null
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
  session.alternateScreenBackgroundRepaintTimer = null
  session.shiftEnterReconfirmTimer = null
  session.synchronizedForegroundOutputActive = false
  // Why: carries up to one marker-length-1 of trailing bytes so a ConPTY-split DEC 2026 marker is still detected (#8754).
  session.synchronizedForegroundMarkerTail = ''
  // Why: tracks the keystroke proximity captured when the current synchronized
  // foreground frame opened, so a split end marker that lands after the redraw
  // window still drains on the fast path instead of the 1s coalesce fallback.
  session.synchronizedForegroundFrameInteractive = false
  session.suppressStructuralReplayPtyResize = false
  // Why: hidden-delivery gate sync is wired up alongside the deferred PTY
  // output plumbing inside the connect frame; lifecycle hooks (visibility
  // flips, exit, dispose) run before/after it exists, so start with no-ops.
  session.syncHiddenRendererPtyDelivery = () => {}
  session.releaseHiddenRendererPtyDelivery = () => {}
  session.handleRemoteOutputPauseChanged = () => {}
  session.handleRendererOwnedAgentStatus = () => {}
  session.remoteOutputGatedPtyId = null
  session.remoteOutputFactConsumerPtyId = null
  session.suppressViewportClaimTerminalResize = false
  // Why: idle callbacks are registered before the deferred PTY output plumbing
  // exists. Start with the shared scheduler, then switch to the PTY writer
  // below so hidden-tab resets keep backlog-recovery callbacks and byte order.
  session.idleAgentTerminalModeReset = RESET_TERMINAL_CURSOR_STYLE
  session.suppressNativeWindowsIdleCodexFocusReports = false
  session.setFocusReportSuppressionForAgentCompletion = (
    title: string | undefined,
    agentType: AgentType | undefined
  ): void => {
    const titleAgentType = resolveCommittedTitleAgentType(title ?? '')
    session.suppressNativeWindowsIdleCodexFocusReports =
      agentType && agentType !== 'unknown' ? agentType === 'codex' : titleAgentType === 'codex'
  }
  session.queueAgentIdleTerminalModeReset = (): void => {
    if (session.disposed) {
      return
    }
    writeTerminalOutput(session.pane.terminal, session.idleAgentTerminalModeReset, {
      foreground: shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
    })
  }
  // Why: passphrase-gate waits register a teardown here so dispose() can
  // actively unsubscribe + resolve them. Without this, a pane disposed
  // mid-wait leaks its zustand subscriber and the surrounding async IIFE
  // forever, since the subscriber's `disposed` check only fires when the
  // store next emits — which may never happen after disconnect.
  session.waitTeardowns = []
  // Why: startup commands must only run once — in the pane they were
  // targeted at. Capture `deps.startup` into a local and clear the field on
  // the (already spread-copied) `deps` so nothing else inside this function
  // can accidentally re-read it. The caller is responsible for clearing its
  // own outer reference, since `deps` here is a shallow copy and our
  // mutation does not propagate back.
  session.paneStartup = session.deps.startup ?? null
  session.deps.startup = undefined

  // Why: paneKey crosses PTY env, hook IPC, retained rows, and reload/replay.
  // Use the stable layout leaf UUID, not the renderer-local numeric pane id.
  session.cacheKey = makePaneKey(session.deps.tabId, session.pane.leafId)
  // Why: mirrors the kitty keyboard flags the pane's application negotiates.
  // Fed only from application output (live PTY bytes + daemon replay
  // payloads), never from renderer-generated resets, so it reflects what the
  // application expects even after defensive renderer-side kitty wipes.
  session.kittyKeyboardModes = (() => {
    const existing = session.deps.paneKittyKeyboardModesRef.current.get(session.pane.id)
    if (existing) {
      return existing
    }
    const created = new TerminalKittyKeyboardModeTracker()
    session.deps.paneKittyKeyboardModesRef.current.set(session.pane.id, created)
    return created
  })()
  installSleepingRecordAccess(session)
  installShellCommandInference(session)
  installInterruptInputIntent(session)
  installTerminalKeydownFit(session)
  installPtyExitHibernate(session)
  installTitleSpawnBell(session)
  installAgentTaskCompleteNotify(session)
  installDirectSshRetryStatus(session)
  installPtyInputRecovery(session)
  // Async reattach/exit callbacks can outlive the PaneManager that created
  // them. Keep their layout writes keyed by the durable leaf identity and
  // admit them only while this transport still owns the pane slot.
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
  installPtyInputForward(session)
  installPtyResizeGeometry(session)
  installRunDeferredConnect(session)
  return installSessionReconcileDispose(session)
}
