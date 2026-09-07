import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import { installTerminalImeCompositionRoute } from '../terminal-ime-composition-route'
import { useAppStore } from '@/store'
import { isTerminalQueryReply } from '../../../../../shared/terminal-query-reply'
import { safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { requestStablePaneFit } from '@/lib/pane-manager/pane-fit-resize-observer'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { getAppliedSizeReadE2eDelayMs } from '../pty-applied-size-read-e2e-delay'
import { createPtySizeReassertion } from '../pty-size-reassertion'
import { isPaneReplaying } from '../replay-guard'
import { shouldDropQuarantinedTerminalInput } from '../terminal-input-quarantine'
import {
  PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
  queuePanePtyResizeIfHeld,
  type PanePtyResizeHoldFlushDetail
} from '@/lib/pane-manager/pane-pty-resize-hold'

import { FOREGROUND_GRID_DRIFT_CHECK_MIN_MS } from './foreground-output-budgets'
import { TERMINAL_FOCUS_IN_SEQUENCE, TERMINAL_FOCUS_OUT_SEQUENCE } from './foreground-output-scan'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { isCodexPaneStale } from './codex-pane-stale'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPtyInputForward(session: ConnectPanePtySession): void {
  session.forwardPtyInput = (data: string): void => {
    // Why: xterm auto-replies to embedded query sequences (DA1, DECRQM,
    // OSC 10/11, focus, CPR) via onData. When we replay recorded PTY bytes
    // into xterm for scrollback/cold-restore/snapshot, those queries would
    // otherwise pipe replies into the freshly spawned shell as stray input
    // ("?1;2c", "2026;2$y", OSC color fragments, ...). The replay sites
    // engage the guard via replayIntoTerminal; here we drop everything
    // xterm emits while the guard is active. See replay-guard.ts.
    if (isPaneReplaying(session.deps.replayingPanesRef, session.pane.id)) {
      return
    }
    const currentPtyId = session.transport.getPtyId()
    // Why: after a Codex account switch, the runtime auth has already moved to
    // the newly selected account. Stale panes must not keep sending input until
    // they restart, or work can execute under the wrong account while the UI
    // still says the pane is stale. Fall back to the tab's persisted PTY ID so
    // the block still holds during reconnect races before the live transport has
    // updated its local PTY binding.
    if (
      isCodexPaneStale({
        tabId: session.deps.tabId,
        worktreeId: session.deps.worktreeId,
        panePtyId: currentPtyId
      })
    ) {
      session.clearPendingTerminalInputIntent()
      return
    }
    // Why: presence-lock input drop. While mobile is the driver for this
    // PTY, desktop keystrokes must not reach the shell; the visible overlay's
    // explicit Take back action owns restoring desktop input and dimensions.
    if (currentPtyId && isPtyLocked(currentPtyId)) {
      session.clearPendingTerminalInputIntent()
      return
    }
    if (
      session.isNativeWindowsConpty &&
      session.suppressNativeWindowsIdleCodexFocusReports &&
      (data === TERMINAL_FOCUS_IN_SEQUENCE || data === TERMINAL_FOCUS_OUT_SEQUENCE)
    ) {
      // Why: Codex can leave focus reporting armed after a Windows turn, but
      // disabling the mode would permanently silence focus events on resume.
      return
    }
    // Why: xterm answers CPR/DSR/DA queries natively through this same onData
    // stream (mixed with keystrokes). Those replies are latency-critical — a
    // querying program reads them in raw mode with a short timeout — so send
    // them immediately, skipping the remote input debounce that would corrupt
    // them (#7329). They are not user input, so they bypass intent inference and
    // activity recording below. No pending-intent guard: the only intents are
    // plain-escape (`\x1b`) and ctrl-c (`\x03`), neither of which can satisfy
    // isTerminalQueryReply (it requires length >= 3 and a full reply grammar),
    // so a real keystroke never reaches this branch.
    if (isTerminalQueryReply(data)) {
      session.sendDesktopQueryReplyImmediate(data)
      return
    }
    // Why after the query-reply branch: device replies are not user input and
    // must always reach the shell, or a program querying during reattach hangs.
    // Why at all: a replaced endpoint reattaches to a fresh shell, so the tail
    // of the interrupted line would be submitted by the user's own Enter and a
    // compound command could run its surviving half (#10065 follow-up).
    if (shouldDropQuarantinedTerminalInput(session.deps.tabId, data)) {
      session.clearPendingTerminalInputIntent()
      return
    }
    const intent = session.pendingTerminalInputIntent
    // Why: real xterm can deliver the terminal byte even when our DOM keydown
    // listener missed the press. Exact Ctrl+C/Escape bytes are still safe to
    // infer for local/remote acknowledged writes; SSH fire-and-forget remains
    // excluded because those transports do not expose sendInputAccepted.
    const acknowledgedIntent = intent ?? session.inferIntentFromExactTerminalInput(data)
    if (acknowledgedIntent && session.transport.sendInputAccepted) {
      const interruptStatusBaseline =
        useAppStore.getState().agentStatusByPaneKey[session.cacheKey] ?? null
      // Why: equal snapshots retain double-Escape semantics while older snapshots lose ack races.
      if (session.sequencedInterruptStatusBaseline !== interruptStatusBaseline) {
        session.sequencedInterruptStatusBaseline = interruptStatusBaseline
        session.interruptStatusBaselineSequence += 1
      }
      const capturedBaselineSequence = session.interruptStatusBaselineSequence
      session.claimViewportForUserActivity()
      if (acknowledgedIntent === 'ctrl-c') {
        // Why: the accepted-write callback is async; let the next command be
        // inferred if the user cancelled an oversized line and immediately typed.
        session.cancelSuspendedShellCommandInference()
      }
      session.clearPendingTerminalInputIntent()
      const writePromise = session.transport
        .sendInputAccepted(data)
        .then((accepted): boolean | Promise<boolean> | null => {
          if (accepted) {
            // Why: rejected writes use transport recovery and must not arm a parser probe.
            session.markAcceptedTerminalInputSent()
            session.observeAcceptedShellCommandInput(data)
            session.observeAcceptedTerminalInput(data, acknowledgedIntent)
            const immediateResult = session.interruptInference.observeInputIntent(
              acknowledgedIntent,
              interruptStatusBaseline,
              capturedBaselineSequence
            )
            session.observeTitleOnlyInterrupt()
            return immediateResult ?? null
          }
          // Why: Esc/Ctrl+C are the first keys users press on a frozen pane;
          // an unbound-transport reject here must arm recovery too.
          session.requestRecoveryForUndeliverableInput()
          return null
        })
        .catch((err) => {
          console.warn('[agent-interrupt] acknowledged terminal input failed:', err)
          return null
        })
      session.setPendingTerminalInputWrite(writePromise)
      return
    }
    if (intent) {
      session.claimViewportForUserActivity()
      if (session.transport.sendInput(data)) {
        session.markAcceptedTerminalInputSent()
        session.observeAcceptedShellCommandInput(data)
        session.observeAcceptedTerminalInput(data, intent)
      } else {
        session.requestRecoveryForUndeliverableInput()
      }
      session.clearPendingTerminalInputIntent()
      return
    }
    session.claimViewportForUserActivity()
    if (session.transport.sendInput(data)) {
      session.markAcceptedTerminalInputSent()
      session.observeAcceptedShellCommandInput(data)
      session.observeAcceptedTerminalInput(data)
      session.observeSentTerminalInputIntent(data)
    } else {
      session.clearPendingTerminalInputIntent()
      session.requestRecoveryForUndeliverableInput()
    }
  }
  session.onDataDisposable = session.pane.terminal.onData((data) => {
    if (session.deps.deferPtyInput) {
      session.deps.deferPtyInput(session.pane.id, data, session.forwardPtyInput)
      return
    }
    session.forwardPtyInput(data)
  })
  session.imeCompositionRouteDisposable = installTerminalImeCompositionRoute({
    terminalElement: session.pane.terminal.element,
    terminal: session.pane.terminal,
    capturedTransport: session.transport,
    getCurrentTransport: () => session.deps.paneTransportsRef.current.get(session.pane.id)
  })

  session.shouldSuppressDesktopPtyResize = (): boolean => {
    const currentPtyId = session.transport.getPtyId()
    return Boolean(
      currentPtyId && (getFitOverrideForPty(currentPtyId) || isPtyLocked(currentPtyId))
    )
  }

  session.isRendererPtyResizeAuthoritative = (): boolean => {
    if (session.deps.isVisibleRef.current) {
      return true
    }
    // Why: hidden-tab layout churn is not authoritative; visible resume
    // owns correction, and hidden SIGWINCH can reset full-screen TUIs.
    return false
  }

  session.forwardPtyResize = (cols: number, rows: number): void => {
    if (!session.isRendererPtyResizeAuthoritative()) {
      return
    }
    // Why: when a mobile-fit override is active OR mobile is currently the
    // driver of this PTY, the PTY is already at phone dims and any desktop
    // resize is wrong. Suppress resize forwarding to avoid spurious SIGWINCH
    // signals (TUI flicker / wrap corruption). Both checks are needed:
    // - getFitOverrideForPty covers the "phone-fit dims" state.
    // - isPtyLocked covers the broader "mobile driving" state, including
    //   transitions where override may not be set (e.g. legacy code paths).
    // The pty:resize IPC has a defense-in-depth twin. See
    // docs/mobile-presence-lock.md.
    if (session.shouldSuppressDesktopPtyResize()) {
      return
    }
    if (queuePanePtyResizeIfHeld(session.pane.container, cols, rows)) {
      return
    }
    session.transport.resize(cols, rows, { claim: true })
  }

  session.onHeldPtyResizeFlush = (event: Event): void => {
    const detail = (event as CustomEvent<PanePtyResizeHoldFlushDetail>).detail
    if (!detail) {
      return
    }
    session.forwardPtyResize(detail.cols, detail.rows)
  }
  session.pane.container.addEventListener(
    PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
    session.onHeldPtyResizeFlush
  )

  session.onResizeDisposable = session.pane.terminal.onResize(({ cols, rows }) => {
    if (session.suppressStructuralReplayPtyResize || session.suppressViewportClaimTerminalResize) {
      return
    }
    session.forwardPtyResize(cols, rows)
  })

  // Why: renderer resize forwarding is fire-and-forget. A visible pane can
  // finish with xterm at the right grid while the PTY silently kept an older
  // grid, so Codex keeps composing against stale columns. Fit first so xterm's
  // normal onResize can send, then read applied PTY size and repair only drift.
  session.ptySizeReassertion = createPtySizeReassertion({
    isDisposed: () => session.disposed,
    getPtyId: () => session.transport.getPtyId(),
    isRemotePtyId: isRemoteRuntimePtyId,
    shouldSuppressDesktopResize: () => session.shouldSuppressDesktopPtyResize(),
    fitAndRun: (continuation) => safeFitAndThen(session.pane, 'pty-size-reassertion', continuation),
    getTerminalDimensions: () => ({
      cols: session.pane.terminal.cols,
      rows: session.pane.terminal.rows
    }),
    getAppliedSize: async (ptyId) => {
      // Why: e2e seam — delays the read past the reveal fit to reproduce the
      // busy-daemon/SSH ordering; returns 0 outside e2e builds.
      const delayMs = getAppliedSizeReadE2eDelayMs()
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return window.api.pty.getSize(ptyId)
    },
    forwardResize: session.forwardPtyResize
  })
  // Why built here and not inside session.handleReattachResult: a hidden pane parks this until it is
  // revealed, and a closure created in that scope would pin the whole reattach payload
  // (snapshot/replay/coldRestore bytes) for as long as the pane stays hidden. Taking the
  // generation and pty id by value keeps only connection-level state alive.
  session.createReattachGridPush = (
    attemptGeneration: number,
    reattachPtyId: string
  ): { shouldContinue: () => boolean; continuation: () => void } => {
    const isCurrent = (): boolean =>
      !session.disposed &&
      attemptGeneration === session.transportStreamGeneration &&
      session.transport.getPtyId() === reattachPtyId
    return {
      shouldContinue: isCurrent,
      continuation: () => {
        if (!isCurrent()) {
          return
        }
        // Why re-checked at fire time: the caller's pre-check cannot see a mobile takeover that
        // lands while the pane waits for a box, and transport.resize here bypasses
        // forwardPtyResize's own suppression.
        if (session.shouldSuppressDesktopPtyResize()) {
          return
        }
        const reattachCols = session.pane.terminal.cols
        const reattachRows = session.pane.terminal.rows
        if (reattachCols > 0 && reattachRows > 0) {
          session.transport.resize(reattachCols, reattachRows)
        }
        // Why: POSIX only sends SIGWINCH on an actual dimension change; signal explicitly so restored TUIs repaint at the correct cursor after replay.
        if (!isRemoteRuntimePtyId(reattachPtyId)) {
          window.api.pty.signal(reattachPtyId, 'SIGWINCH')
        }
        // Why here: a deferred reveal resolves the fit handle as incomplete, so an awaited
        // reassertion at the call site would never run for that path.
        if (session.deps.isVisibleRef.current) {
          session.ptySizeReassertion.request({ fit: false })
        }
      }
    }
  }
  session.pendingForegroundGridDriftCheckRaf = null
  session.lastForegroundGridDriftCheckAt = Number.NEGATIVE_INFINITY
  session.readProposedTerminalGrid = (): { cols: number; rows: number } | null => {
    try {
      const proposed = session.pane.fitAddon.proposeDimensions()
      if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) {
        return null
      }
      return proposed
    } catch {
      return null
    }
  }
  session.terminalGridDriftedFromFit = (): boolean => {
    const proposed = session.readProposedTerminalGrid()
    return Boolean(
      proposed &&
      (session.pane.terminal.cols !== proposed.cols || session.pane.terminal.rows !== proposed.rows)
    )
  }
  session.scheduleForegroundGridDriftCheck = (): void => {
    // Why: mobile-owned PTYs intentionally keep a non-desktop grid; drift
    // healing would refit xterm even if resize forwarding is later suppressed.
    if (
      session.disposed ||
      !session.deps.isVisibleRef.current ||
      session.shouldSuppressDesktopPtyResize() ||
      session.pendingForegroundGridDriftCheckRaf !== null
    ) {
      return
    }
    const now = performance.now()
    if (now - session.lastForegroundGridDriftCheckAt < FOREGROUND_GRID_DRIFT_CHECK_MIN_MS) {
      return
    }
    session.lastForegroundGridDriftCheckAt = now
    session.pendingForegroundGridDriftCheckRaf = requestAnimationFrame(() => {
      session.pendingForegroundGridDriftCheckRaf = null
      if (
        session.disposed ||
        !session.deps.isVisibleRef.current ||
        session.shouldSuppressDesktopPtyResize() ||
        !session.terminalGridDriftedFromFit()
      ) {
        return
      }
      // Why: xterm cell metrics can settle after the DOM box stops resizing, so
      // ResizeObserver never fires even though FitAddon now proposes more cols.
      requestStablePaneFit(session.pane as ManagedPaneInternal, () =>
        session.ptySizeReassertion.request({ fit: false })
      )
    })
  }

  // Why: observe the outer pane as the layout signal for both desktop drift
  // healing and mobile take-back. Normal desktop panes compare xterm against
  // the PTY's applied size; mobile-fit panes only report desktop geometry so
  // the parked phone-sized PTY is not resized. See docs/mobile-fit-hold.md.
  session.pendingGeometryReportRaf = null
  session.lastObservedDesktopGrid = null
  session.readPaneSize = (): { width: number; height: number } | null => {
    if (typeof session.pane.container.getBoundingClientRect !== 'function') {
      return null
    }
    const rect = session.pane.container.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }
  session.lastObservedPaneSize = session.readPaneSize()
  session.pendingPaneGeometryChanged = false
}
