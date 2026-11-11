import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { safeFit } from '@/lib/pane-manager/terminal-fit/pane-fit'
import {
  bindPanePtyId,
  getFitOverrideForPty
} from '@/lib/pane-manager/terminal-fit/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import {
  primeReattachedPtyKittyKeyboardModeTracker,
  registerPtyKittyKeyboardModeTracker,
  unregisterPtyKittyKeyboardModeTracker
} from '../../input/keyboard/terminal-pty-kitty-keyboard-flags'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindPanePtyFit(session: ConnectPanePtySession): void {
  session.visibleRemoteViewportClaimPtyId = null
  session.pendingVisibleRemoteViewportClaim = false
  session.setPanePtyFitBinding = (ptyId: string, replayReattachment = false): void => {
    const previousPtyId = session.activePanePtyBinding
    if (previousPtyId && previousPtyId !== ptyId) {
      unregisterPtyKittyKeyboardModeTracker(
        previousPtyId,
        session.activePtyKittyKeyboardModeRegistration
      )
    }
    session.activePtyKittyKeyboardModeRegistration = registerPtyKittyKeyboardModeTracker(
      ptyId,
      session.kittyKeyboardModes
    )
    if (replayReattachment) {
      primeReattachedPtyKittyKeyboardModeTracker(
        ptyId,
        session.activePtyKittyKeyboardModeRegistration
      )
    }
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
  session.activePtyKittyKeyboardModeRegistration = null
  // Why: bind time lets async liveness reconcile ignore a request started
  // before this PTY bound (newborn race). Null disables the guard (fail-safe).
  session.activePanePtyBindingBoundAt = null
}

export function bindPanePtyFitRelease(session: ConnectPanePtySession): void {
  session.clearPanePtyFitBinding = (): void => {
    // Clear module-level fit bindings explicitly; DOM removal cannot release them.
    if (session.activePanePtyBinding) {
      unregisterPtyKittyKeyboardModeTracker(
        session.activePanePtyBinding,
        session.activePtyKittyKeyboardModeRegistration
      )
    }
    bindPanePtyId(session.pane.id, null, session.deps.tabId)
    session.visibleRemoteViewportClaimPtyId = null
    session.pendingVisibleRemoteViewportClaim = false
    session.activePanePtyBinding = null
    session.activePtyKittyKeyboardModeRegistration = null
    session.activePanePtyBindingBoundAt = null
    delete session.pane.container.dataset.ptyId
    delete session.pane.container.dataset.ptyRecoveryState
  }
}
