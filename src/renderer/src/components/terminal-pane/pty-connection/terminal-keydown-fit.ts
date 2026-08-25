import { useAppStore } from '@/store'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { bindPanePtyId, getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { parseAppSshPtyId } from '../../../../../shared/ssh-pty-id'
import { isFreshNonDoneAgentStatus } from '../../../../../shared/agent-status-types'
import { isCtrlCKeyEvent, isPlainEscapeKeyEvent } from '../agent-interrupt-inference'
import { createAgentCompletionCoordinator } from '../agent-completion-coordinator'
import { dispatchAgentHookTerminalLifecycle } from '../agent-hook-terminal-lifecycle'
import { createCodexAutoApprovalHookCompletionSuppressor } from '../codex-auto-approval-notification-suppression'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { registerTerminalSideEffectFactConsumer } from '../terminal-side-effect-facts-handler'

import { isAgentTaskCompleteTrackingEnabled } from './agent-task-complete-settings'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Keydown intent, PTY fit binding, side-effect fact consumption, and the agent completion coordinator. */
export function installTerminalKeydownFit(session: ConnectPanePtySession): void {
  session.onTerminalKeyDown = (event: KeyboardEvent): void => {
    if (isPlainEscapeKeyEvent(event)) {
      session.setPendingTerminalInputIntent('plain-escape')
      // Why: plain Escape produces real terminal input (\x1b), so it is a
      // genuine "user is here" signal and must still dismiss attention before
      // the early return for interrupt-intent inference.
      session.deps.clearTerminalTabUnread(session.deps.tabId)
      session.deps.clearTerminalPaneUnread(session.cacheKey)
      session.deps.clearWorktreeUnread(session.deps.worktreeId)
      return
    }
    if (isCtrlCKeyEvent(event)) {
      if (!navigator.userAgent.includes('Mac') && session.pane.terminal.hasSelection()) {
        return
      }
      session.setPendingTerminalInputIntent('ctrl-c')
    }
    // Why: only treat keydowns that will produce real terminal input as the
    // "user is here" signal. Modifier-only presses, autorepeat, and Cmd/Ctrl+C
    // copy chords with an active selection must not dismiss attention on a
    // sibling pane before the user has seen it.
    if (
      event.repeat ||
      event.key === 'Alt' ||
      event.key === 'AltGraph' ||
      event.key === 'Control' ||
      event.key === 'Meta' ||
      event.key === 'Shift'
    ) {
      return
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'c' &&
      session.pane.terminal.hasSelection()
    ) {
      return
    }
    // Why: user shell frameworks (bash-preexec/iTerm2) can replace Orca's
    // OSC 133;C hook, so a manually launched agent produces no command-start
    // signal at all. Enter at a shell-foreground prompt is the user-side
    // equivalent; the sample is gated to panes with no live agent identity
    // and publishes nothing for an idle shell.
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      session.sampleVisiblePaneForegroundAgent()
    }
    session.deps.clearTerminalTabUnread(session.deps.tabId)
    session.deps.clearTerminalPaneUnread(session.cacheKey)
    session.deps.clearWorktreeUnread(session.deps.worktreeId)
  }
  // Why: infer only from focused xterm key events. Raw PTY bytes cannot
  // distinguish plain Escape from Alt/meta sequences, and programmatic writes
  // should not clear agent status.
  session.terminalKeyTarget = session.pane.terminal.element ?? session.pane.container
  session.terminalKeyTargetSupportsEvents =
    typeof session.terminalKeyTarget?.addEventListener === 'function' &&
    typeof session.terminalKeyTarget?.removeEventListener === 'function'
  if (session.terminalKeyTargetSupportsEvents) {
    session.terminalKeyTarget.addEventListener('keydown', session.onTerminalKeyDown, {
      capture: true
    })
  }

  session.visibleRemoteViewportClaimPtyId = null
  session.pendingVisibleRemoteViewportClaim = false
  session.setPanePtyFitBinding = (ptyId: string): void => {
    bindPanePtyId(session.pane.id, ptyId, session.deps.tabId)
    session.pane.container.dataset.ptyId = ptyId
    if (
      session.deps.isVisibleRef.current &&
      isRemoteRuntimePtyId(ptyId) &&
      session.visibleRemoteViewportClaimPtyId !== ptyId
    ) {
      // Why: the initial fit event consumes this activation arm before later peer ownership changes.
      session.visibleRemoteViewportClaimPtyId = ptyId
      session.pendingVisibleRemoteViewportClaim = true
    }
    // Why: override hydration can arrive before this pane knows its PTY. Once
    // data-pty-id is bound, safeFit can park xterm at the authoritative grid.
    if (getFitOverrideForPty(ptyId)) {
      safeFit(session.pane)
    }
    session.claimPendingVisibleRemoteViewport()
  }
  session.activePanePtyBinding = null
  // Why: bind time lets async liveness reconcile ignore a request started
  // before this PTY bound (newborn race). Null disables the guard (fail-safe).
  session.activePanePtyBindingBoundAt = null

  // Why: with main side-effect authority on, the pane's title/bell/agent
  // policy callbacks consume pty:sideEffect facts instead of transport byte
  // parsers (which stay unregistered) — same policy code, single consumer.
  // restoreTitleOnRegister replaces the eager-replay title restore: main's
  // title-only snapshot carries the no-attention-replay rule.
  session.unregisterSideEffectFactConsumer = null
  session.registerSideEffectFactConsumerForPty = (
    ptyId: string,
    remoteOutputPaused = false
  ): void => {
    if ((!session.mainSideEffectAuthority && !remoteOutputPaused) || session.disposed) {
      return
    }
    session.unregisterSideEffectFactConsumer?.()
    session.unregisterSideEffectFactConsumer = registerTerminalSideEffectFactConsumer({
      ptyId,
      callbacks: {
        onTitleChange: session.onTitleChange,
        onBell: session.onBell,
        onAgentBecameIdle: session.onAgentBecameIdle,
        onAgentBecameWorking: session.onAgentBecameWorking,
        onAgentExited: session.onAgentExited,
        onCommandFinished: session.handleCommandFinished,
        onPrLink: (link) =>
          useAppStore
            .getState()
            .observeTerminalGitHubPullRequestLink(session.deps.worktreeId, link),
        // Why: the Command Code settle policy stays here — the done settle
        // timer must consult the live store row (which hook events and
        // renderer seeds also write), so main only emits scrape facts.
        onCommandCodeWorking: session.seedCommandCodeOutputWorkingStatus,
        onCommandCodeDone: session.scheduleCommandCodeOutputDoneStatus,
        ...(session.shouldOwnAgentStatusInRenderer
          ? { onAgentStatus: (payload) => session.handleRendererOwnedAgentStatus(payload) }
          : {}),
        // Why: gated hidden panes never see the subscribe bytes; the fact
        // replaces the byte scan (and the old post-latch subscribe drop).
        ...(session.hiddenDeliveryGateActive || remoteOutputPaused
          ? {
              onMode2031Subscribe: session.handleHiddenMode2031SubscribeFact,
              onMode2031Unsubscribe: session.handleHiddenMode2031UnsubscribeFact
            }
          : {})
      },
      restoreTitleOnRegister: true
    })
  }
  session.dropSideEffectFactConsumer = (): void => {
    session.unregisterSideEffectFactConsumer?.()
    session.unregisterSideEffectFactConsumer = null
    session.remoteOutputFactConsumerPtyId = null
  }
  session.clearPanePtyFitBinding = (): void => {
    // Why: fit bindings live in a module-level map, so pane teardown must
    // clear them explicitly instead of relying on DOM removal.
    bindPanePtyId(session.pane.id, null, session.deps.tabId)
    session.visibleRemoteViewportClaimPtyId = null
    session.pendingVisibleRemoteViewportClaim = false
    session.activePanePtyBinding = null
    session.activePanePtyBindingBoundAt = null
    delete session.pane.container.dataset.ptyId
    delete session.pane.container.dataset.ptyRecoveryState
  }

  session.agentCompletionCoordinator = createAgentCompletionCoordinator({
    paneKey: session.cacheKey,
    statusLane: 'pty',
    getPtyId: () => session.transport.getPtyId(),
    getSettings: () => useAppStore.getState().settings,
    inspectProcess: inspectRuntimeTerminalProcess,
    dispatchHookLifecycle: (payload) =>
      dispatchAgentHookTerminalLifecycle(session.cacheKey, payload),
    shouldSuppressProcessReplacementCompletion: (_exited, replacement) => {
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      const currentAgentForReplacement = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        replacement.agent
      )
      return (
        isFreshNonDoneAgentStatus(currentStatus) && currentAgentForReplacement === replacement.agent
      )
    },
    shouldSuppressConfirmedProcessExitCompletion: (exited) => {
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      const currentAgentForExited = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        exited.agent
      )
      // Why: a replacement hook can lead process visibility by one cadence;
      // only a different known active owner can veto confirmed old-process exit.
      return Boolean(
        isFreshNonDoneAgentStatus(currentStatus) &&
        currentStatus.agentType &&
        currentStatus.agentType !== 'unknown' &&
        currentAgentForExited !== exited.agent
      )
    },
    dispatchCompletion: (title, meta) => {
      if (meta?.source === 'process-exit') {
        session.clearSuppressedTitleSideEffects()
      }
      if (meta?.terminalIdleConfirmed === true) {
        // Why: an agent can crash before its done hook; confirmed process death
        // must still restore cursor and native Windows Kitty keyboard modes.
        const currentAgentStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
        if (!isFreshNonDoneAgentStatus(currentAgentStatus)) {
          session.setFocusReportSuppressionForAgentCompletion(title, meta.agentStatus?.agentType)
        }
        session.queueAgentIdleTerminalModeReset()
      }
      session.scheduleAgentTaskCompleteNotification(title, {
        allowDoneDetailAfterGrace: meta?.quietedHookDone,
        ...(meta?.source === 'process-exit' ? { agentCompletionSource: meta.source } : {}),
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      })
    },
    dispatchAttention: (title, meta) =>
      session.scheduleAgentTaskCompleteNotification(title, {
        agentStatusSnapshot: meta.agentStatus
      }),
    shouldPollProcessCadence: () =>
      isAgentTaskCompleteTrackingEnabled() && session.deps.isVisibleRef.current,
    isProcessInspectionCostly: () => {
      // Why: local Windows inspection forks a powershell.exe whole-process-table
      // CIM scan per poll (~10-40x heavier than POSIX `ps`); SSH/remote PTYs run
      // their scans on the remote host, so only local Windows panes relax the
      // no-evidence cadence.
      if (!navigator.userAgent.includes('Windows')) {
        return false
      }
      const ptyId = session.transport.getPtyId()
      return ptyId !== null && !isRemoteRuntimePtyId(ptyId) && parseAppSshPtyId(ptyId) === null
    },
    isLive: () => {
      if (session.disposed) {
        return false
      }
      if (session.transport.getPtyId()) {
        return true
      }
      return (useAppStore.getState().ptyIdsByTabId[session.deps.tabId] ?? []).length > 0
    },
    shouldSuppressHookCompletion: createCodexAutoApprovalHookCompletionSuppressor(
      session.cacheKey,
      () => ({
        tabId: session.deps.tabId,
        ...(session.launchToken ? { launchToken: session.launchToken } : {})
      })
    )
  })
}
