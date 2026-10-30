import { attachTerminalResidentPresentation } from './terminal-resident-presentation'
import { captureNotificationTransportOwner } from '@/attention/notification-subject-owner'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { bindPanePtyId, getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { isCtrlCKeyEvent, isPlainEscapeKeyEvent } from '../agent-interrupt-inference'
import { registerTerminalSideEffectFactConsumer } from '../terminal-side-effect-facts-handler'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Keydown intent, PTY fit binding, side-effect fact consumption, and the agent completion coordinator. */
export function installTerminalKeydownFit(session: ConnectPanePtySession): void {
  session.onTerminalKeyDown = (event: KeyboardEvent): void => {
    if (isPlainEscapeKeyEvent(event)) {
      session.setPendingTerminalInputIntent('plain-escape')
      return
    }
    if (isCtrlCKeyEvent(event)) {
      if (!navigator.userAgent.includes('Mac') && session.pane.terminal.hasSelection()) {
        return
      }
      session.setPendingTerminalInputIntent('ctrl-c')
    }
    // Why: only keydowns that will produce real terminal input reach the sample
    // below; modifier-only presses, autorepeat, and copy chords do not.
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
    // Enter at shell foreground backs up OSC 133;C hooks replaced by shell frameworks; confirm only panes without live agent identity.
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      session.sampleVisiblePaneForegroundAgent?.()
    }
  }
  // Infer from focused key events; raw bytes conflate Escape with Alt/meta and programmatic writes must not clear status.
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
    const hasFitOverride = getFitOverrideForPty(ptyId) !== null
    if (hasFitOverride) {
      safeFit(session.pane)
    }
    // Why: the overlay tick skipped that early event (no pane owned this PTY yet),
    // so the parked grid would otherwise show no "sized for your phone" banner.
    if (hasFitOverride || isPtyLocked(ptyId)) {
      session.deps.refreshMobileOverlays?.()
    }
    session.claimPendingVisibleRemoteViewport()
  }
  session.activePanePtyBinding = null
  // Why: bind time lets async liveness reconcile ignore a request started
  // before this PTY bound (newborn race). Null disables the guard (fail-safe).
  session.activePanePtyBindingBoundAt = null

  // Main-authority facts replace byte parsers as the single policy consumer; title snapshots restore metadata without attention replay.
  session.unregisterSideEffectFactConsumer = null
  session.registerSideEffectFactConsumerForPty = (
    ptyId: string,
    _remoteOutputPaused = false
  ): void => {
    if (session.disposed) {
      return
    }
    const binding = {
      paneKey: session.cacheKey,
      tabId: session.deps.tabId,
      worktreeId: session.deps.worktreeId,
      cwd: session.deps.cwd,
      startup: session.paneStartup,
      initialTitle: session.getCurrentTerminalTitle() ?? undefined,
      launchToken: session.launchToken,
      runtimeEnvironmentId: session.runtimeEnvironmentId,
      workspaceOwner: captureNotificationTransportOwner(session.transport)
    }
    const services = {
      setCacheTimerStartedAt: session.deps.setCacheTimerStartedAt,
      markTerminalBell: session.deps.markTerminalBell,
      dispatchNotification: session.deps.dispatchNotification
    }
    session.unregisterSideEffectFactConsumer?.()
    session.unregisterSideEffectFactConsumer = registerTerminalSideEffectFactConsumer({
      ptyId,
      binding,
      services,
      onResident: (resident) => attachTerminalResidentPresentation(session, resident),
      restoreTitleOnRegister: true
    })
  }
  session.dropSideEffectFactConsumer = (): void => {
    session.unregisterSideEffectFactConsumer?.()
    session.unregisterSideEffectFactConsumer = null
    session.remoteOutputFactConsumerPtyId = null
  }
  session.clearPanePtyFitBinding = (): void => {
    // Clear module-level fit bindings explicitly; DOM removal cannot release them.
    bindPanePtyId(session.pane.id, null, session.deps.tabId)
    session.visibleRemoteViewportClaimPtyId = null
    session.pendingVisibleRemoteViewportClaim = false
    session.activePanePtyBinding = null
    session.activePanePtyBindingBoundAt = null
    delete session.pane.container.dataset.ptyId
    delete session.pane.container.dataset.ptyRecoveryState
  }
}
