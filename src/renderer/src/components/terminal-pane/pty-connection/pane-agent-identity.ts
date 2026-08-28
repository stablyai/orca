import { agentTypeToIconAgent } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { replayIntoTerminal } from '../replay-guard'
import { POST_REPLAY_REATTACH_RESET } from '../../../../../shared/terminal-mode-reset-profiles'
import {
  isLocalNativeWindowsConpty,
  resolveWindowsShellOverride
} from '@/lib/pane-manager/windows-pty-compatibility'
import { createTerminalCommandLifecycle } from '../terminal-command-lifecycle'
import { createPaneForegroundAgentTracker } from '../pane-foreground-agent-tracker'
import { isRemoteExecutionHostPtyId } from '../remote-execution-host-pty'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../../shared/tui-agent-config'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Pane agent identity, foreground-agent sampling, and command lifecycle handling. */
export function installPaneAgentIdentity(session: ConnectPanePtySession): void {
  // Why: the 133;D confirmation guard and the visible-pane resampler both key off
  // "does this pane expect an agent"; derive each signal once so the two callers
  // can't drift and silently reintroduce the icon bug this fix closes.
  session.paneHasLiveHookAgentIcon = (state: ReturnType<typeof useAppStore.getState>): boolean => {
    const entry = state.agentStatusByPaneKey[session.cacheKey]
    return entry?.state !== 'done' && Boolean(agentTypeToIconAgent(entry?.agentType))
  }
  // Why: one ladder for both launch-agent signals; a second copy could drift.
  const resolveLaunchAgentCandidate = (
    state: ReturnType<typeof useAppStore.getState>
  ): string | undefined => {
    const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (candidate) => candidate.id === session.deps.tabId
    )
    const registeredLaunchAgent =
      state.agentLaunchConfigByPaneKey[session.cacheKey]?.identity.agentType
    return (
      tab?.launchAgent ??
      session.paneStartup?.launchAgent ??
      session.paneStartup?.initialAgentStatus?.agent ??
      (isTuiAgent(registeredLaunchAgent) ? registeredLaunchAgent : undefined)
    )
  }
  session.paneExpectsLaunchAgent = (state: ReturnType<typeof useAppStore.getState>): boolean =>
    Boolean(resolveLaunchAgentCandidate(state))
  // Why: the concrete TUI agent a fresh spawn is expected to launch, used to seed
  // a command-start confirmation on no-OSC shells (Git Bash/cmd) that never emit
  // one. Returns null when the expectation isn't a recognized TUI agent.
  session.resolveExpectedLaunchTuiAgent = (): TuiAgent | null => {
    const candidate = resolveLaunchAgentCandidate(useAppStore.getState())
    return isTuiAgent(candidate) ? candidate : null
  }
  // Why: a launched/hook-known agent pane must confirm — not trust — a 133;D so a
  // full-screen agent's leaked nested-shell 133;D can't clear its tab identity,
  // even on a restore where no command-start read has recorded evidence yet.
  session.paneHasKnownAgentIdentity = (): boolean => {
    const state = useAppStore.getState()
    const registeredLaunchAgent =
      state.agentLaunchConfigByPaneKey[session.cacheKey]?.identity.agentType
    return (
      Boolean(state.paneForegroundAgentByPaneKey[session.cacheKey]?.agent) ||
      session.paneHasLiveHookAgentIcon(state) ||
      isTuiAgent(registeredLaunchAgent)
    )
  }
  // Why: a plain `codex`/`grok` sets its OSC title and the shell never repaints
  // it on exit, so a confirmed return-to-shell must clear a title that still
  // names an agent — otherwise the tab reads "grok" over a bare prompt. Only
  // reset an agent-named title; user/shell-set titles are left untouched.
  session.clearStaleAgentTabTitleOnConfirmedShell = (): void => {
    const state = useAppStore.getState()
    const currentTitle = state.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
    const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (entry) => entry.id === session.deps.tabId
    )
    const title = currentTitle ?? tab?.title
    if (!title || resolveCommittedTitleAgentType(title) === null) {
      return
    }
    const neutralTitle = session.neutralTerminalTitle()
    session.deps.setRuntimePaneTitle(session.deps.tabId, session.pane.id, neutralTitle)
    if (session.manager.getActivePane()?.id === session.pane.id) {
      session.deps.updateTabTitle(session.deps.tabId, neutralTitle)
    }
  }
  session.deferredCommandFinishedStatusDrop = null
  session.deferredConfirmedShellReconcile = null
  /** The pane's foreground was proven to be a shell, so its agent exited. Unlike a user dismissal,
   *  this must also retire the main-side per-pane caches — a surviving Claude latch resolves the
   *  next event straight back to `working`.
   *
   *  Ordered by the row's `acceptedStatusSeq`, not by row identity or `updatedAt`: the confirming
   *  process read can take seconds, an unrelated field moving in that window is not evidence the
   *  agent is alive, and a genuinely newer row can share the anchor's millisecond. Reading the token
   *  off the row is what makes the ordering safe — the paired drop runs FIRST and removes the row,
   *  and a removed row means nothing reported, not "the anchor is gone".
   *
   *  Residual: a row deleted by some OTHER path mid-window and then rebuilt restarts its count, so a
   *  pane armed at 1 that reports exactly once more compares equal. It needs a foreign drop inside
   *  the confirm window; the relaunch case that would otherwise hit it is already discarded by
   *  onCommandStarted, and the cost is retiring a pane the process table just proved is a shell. */
  const reconcileEndedProcessIfPaneQuiet = (armedAcceptedStatusSeq: number | undefined): void => {
    const current = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    if (current && current.acceptedStatusSeq !== armedAcceptedStatusSeq) {
      return
    }
    // Why: main-side only. The renderer row and launch config are already owned by the deferred
    // drop above; what that path cannot reach is the hook server's per-pane Claude latches, which
    // `agentStatus:drop` deliberately preserves for a still-live pane. Main echoes its own clear
    // back through the pane-status-cleared channel, so both sides stay consistent.
    window.api?.agentStatus?.reconcileEndedProcess?.(session.cacheKey)
  }
  session.visibleForegroundSamplePending = false
  session.visibleForegroundSampleSettled = false
  session.settleDeferredCommandFinishedStatusDrop = (
    options: { confirmedShell?: boolean } = {}
  ): void => {
    const dropStatus = session.deferredCommandFinishedStatusDrop
    const reconcile = session.deferredConfirmedShellReconcile
    session.deferredCommandFinishedStatusDrop = null
    session.deferredConfirmedShellReconcile = null
    dropStatus?.()
    if (options.confirmedShell) {
      reconcile?.()
    }
  }
  session.isForegroundTrackingAllowed = (id: string): boolean => {
    if (isRemoteExecutionHostPtyId(id)) {
      return false
    }
    if (!navigator.userAgent.includes('Windows')) {
      return true
    }
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (candidate) => candidate.id === session.deps.tabId
    )
    // Why: WSL and remote-runtime panes can never authorize native ConPTY
    // bytes, so do not pay for Windows process scans that cannot affect routing.
    return isLocalNativeWindowsConpty({
      userAgent: navigator.userAgent,
      connectionId: getConnectionId(session.deps.worktreeId) ?? null,
      cwd: session.deps.cwd,
      shellOverride: resolveWindowsShellOverride(
        tab?.shellOverride,
        state.settings?.terminalWindowsShell
      ),
      executionHostId: getExecutionHostIdForWorktree(state, session.deps.worktreeId)
    })
  }
  session.paneForegroundAgentTracker = createPaneForegroundAgentTracker({
    getPtyId: () => session.transport.getPtyId(),
    isTrackablePtyId: session.isForegroundTrackingAllowed,
    readForegroundProcess: (id) => window.api.pty.getForegroundProcess(id),
    confirmForegroundProcess: (id) => window.api.pty.confirmForegroundProcess(id),
    publish: (entry) => useAppStore.getState().setPaneForegroundAgent(session.cacheKey, entry),
    hasKnownAgentIdentity: session.paneHasKnownAgentIdentity,
    onConfirmedShellForeground: (reason) => {
      session.clearStaleAgentTabTitleOnConfirmedShell()
      // Why: a hard-killed agent leaves mouse/focus/kitty modes armed, and the
      // surviving shell then receives pointer moves as typed SGR reports; the
      // replay guard keeps xterm's auto-replies from leaking to the shell.
      replayIntoTerminal(session.pane, session.deps.replayingPanesRef, POST_REPLAY_REATTACH_RESET, {
        breadcrumbIdentity: {
          tabId: session.deps.tabId,
          worktreeId: session.deps.worktreeId,
          ptyId: session.transport.getPtyId()
        },
        shouldRefreshViewportSynchronously: session.shouldRefreshForegroundSynchronously
      })
      if (reason === 'visible-pty') {
        useAppStore.getState().clearAgentLaunchConfig(session.cacheKey)
        return
      }
      session.settleDeferredCommandFinishedStatusDrop({ confirmedShell: true })
    },
    // Why wrapped: passed bare, a caller-supplied argument would be read as `options` and could
    // reconcile on the unavailable path, which has no proof the agent exited.
    onCommandFinishedUnavailable: () => session.settleDeferredCommandFinishedStatusDrop(),
    onVisibleForegroundSettled: (outcome) => {
      session.visibleForegroundSamplePending = false
      session.visibleForegroundSampleSettled = outcome !== 'inconclusive'
      if (outcome !== 'inconclusive') {
        return
      }
      const foreground = useAppStore.getState().paneForegroundAgentByPaneKey[session.cacheKey]
      if (foreground?.routingConfirmationPending !== true) {
        return
      }
      useAppStore.getState().setPaneForegroundAgent(session.cacheKey, {
        agent: foreground.agent,
        routingRevoked: true,
        shellForeground: foreground.shellForeground
      })
    }
  })
  // Why: one command-finished policy whether the signal arrives as bytes
  // (remote PTYs, kill switch off) or as a main-derived pty:sideEffect fact —
  // routing both through this handler keeps the drop/interrupt semantics
  // identical across authority modes.
  session.handleCommandFinished = (bestEffortExitCode: number | null): void => {
    session.clearCommandInferredPaneAgentAfterPtySideEffects()
    session.visibleForegroundSamplePending = false
    const shouldDeferStatusDrop = session.paneForegroundAgentTracker.onCommandFinished()
    // Why: the finished command may have moved HEAD or the index (e.g.
    // `git checkout`); nudge git UI now instead of waiting for a poll.
    dispatchTerminalCommandFinishedEvent(session.deps.worktreeId, bestEffortExitCode)
    const state = useAppStore.getState()
    const entry = state.agentStatusByPaneKey[session.cacheKey]
    const inferenceResult = session.flushPendingInterruptInference()
    const dropStatus = (): void => {
      if (inferenceResult === true) {
        session.dropCommandFinishedStatusIfSameTurn(entry, { allowInferredInterrupt: true })
        return
      }
      if (inferenceResult instanceof Promise) {
        void inferenceResult.then((applied) => {
          session.dropCommandFinishedStatusIfSameTurn(entry, {
            allowInferredInterrupt: applied === true
          })
        })
        return
      }
      session.dropCommandFinishedStatusIfSameTurn(entry)
    }
    if (shouldDeferStatusDrop) {
      // Why: keep the concrete pane identity routable while the local process
      // check distinguishes a leaked nested-shell D from a genuine agent exit.
      // Anchor the accepted-status ordinal once, here — not per rung of the confirm ladder, which
      // can span seconds — so the gate tolerates churn across the whole window.
      const armedAcceptedStatusSeq = entry?.acceptedStatusSeq
      session.deferredCommandFinishedStatusDrop = dropStatus
      session.deferredConfirmedShellReconcile = () =>
        reconcileEndedProcessIfPaneQuiet(armedAcceptedStatusSeq)
      return
    }
    session.deferredCommandFinishedStatusDrop = null
    session.deferredConfirmedShellReconcile = null
    dropStatus()
  }
  session.sampleVisiblePaneForegroundAgent = (forceRoutingConfirmation = false): void => {
    if (
      !session.deps.isVisibleRef.current ||
      session.visibleForegroundSamplePending ||
      session.visibleForegroundSampleSettled
    ) {
      return
    }
    const state = useAppStore.getState()
    const foreground = state.paneForegroundAgentByPaneKey[session.cacheKey]
    // Why: a daemon reattach may restore display identity without current
    // routing authority. Only fresh evidence can suppress its confirmation.
    if (foreground?.agent && foreground.routingTrusted === true) {
      return
    }
    if (!forceRoutingConfirmation && session.paneHasLiveHookAgentIcon(state)) {
      return
    }
    const expectsAgent = session.paneExpectsLaunchAgent(state)
    // Why: a completed local process ladder is stronger than stale tab/startup
    // launch metadata. Command-start clears this mark if the pane becomes busy.
    if (foreground?.shellForeground) {
      return
    }
    // Why: tab launch metadata can leak across split panes; rebuild pane-scoped
    // identity from local process state, with remote/SSH excluded by the tracker.
    session.visibleForegroundSamplePending =
      session.paneForegroundAgentTracker.onVisiblePtyBound(expectsAgent)
  }
  session.startAcceptedInferredCommand = (agent) => {
    session.paneForegroundAgentTracker.onCommandStarted(agent)
  }
  session.requestKnownWindowsShiftEnterReconfirmation = () => {
    const foreground = useAppStore.getState().paneForegroundAgentByPaneKey[session.cacheKey]
    // Why: daemon reattach/launch metadata is display-only until a live
    // provider read confirms it. Submit/interrupt/title-exit evidence must
    // revoke that launch-only hint too, otherwise Shift+Enter can route bytes
    // to an agent that already exited before confirmation ever ran.
    if (
      !foreground?.agent ||
      foreground.routingTrusted !== true ||
      TUI_AGENT_CONFIG[foreground.agent].windowsShiftEnterEncoding !== 'csi-u'
    ) {
      return
    }
    // Why: cmd.exe and Git Bash have no OSC command boundaries. Keep the icon
    // as a hint, but revoke bytes until one current provider confirmation lands.
    useAppStore.getState().setPaneForegroundAgent(session.cacheKey, {
      agent: foreground.agent,
      routingRevoked: true,
      shellForeground: false
    })
    session.visibleForegroundSamplePending = false
    session.visibleForegroundSampleSettled = false
    // Why: hook rows can suppress display-only sampling, but cannot restore
    // byte authority after this function explicitly revoked routing trust.
    session.sampleVisiblePaneForegroundAgent(true)
    if (session.paneForegroundAgentTracker.hasReadInFlight()) {
      useAppStore.getState().setPaneForegroundAgent(session.cacheKey, {
        agent: foreground.agent,
        routingRevoked: true,
        shellForeground: false,
        routingConfirmationPending: true
      })
    }
  }
  session.commandLifecycle = createTerminalCommandLifecycle({
    onCommandStarted: () => {
      // Why: a new command invalidates cleanup waiting on the previous D; only
      // a later confirmed shell boundary may retire this pane's live identity.
      session.deferredCommandFinishedStatusDrop = null
      session.visibleForegroundSamplePending = false
      session.visibleForegroundSampleSettled = false
      // Why: typed commands can be aliases, so they only widen the bounded
      // process-confirmation window; they never become routing evidence.
      session.paneForegroundAgentTracker.onCommandStarted(session.commandInferredPaneAgent)
    },
    onCommandFinished: session.handleCommandFinished
  })
  // Why: the xterm OSC 133 swallow is rendering hygiene, not a side effect —
  // it stays attached in every authority mode.
  session.commandLifecycle.attachXtermConsumer(session.pane.terminal)
}
