import { installPaneTerminalInterfacePresentation } from './pane-terminal-interface-presentation'
import { readTerminalInterface } from '../../native-chat/terminal-interface-presentation'
import { dismissRetainedProgramResult } from '@/lib/program-status/result-retention'
import { isRetainedProgramResult } from '@/lib/program-status/row'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import {
  isLocalNativeWindowsConpty,
  resolveWindowsShellOverride
} from '@/lib/pane-manager/windows-pty-compatibility'
import { createTerminalCommandLifecycle } from '../terminal-command-lifecycle'
import { createPaneForegroundAgentTracker } from '../pane-foreground-agent-tracker'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../../shared/tui-agent-config'

import {
  paneShouldAnswerOscColorQueries,
  resolvePaneLaunchAgentCandidate,
  type PaneLaunchAgentPaneSlice
} from './pane-launch-agent-candidate'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { clearStaleAgentTabTitleOnConfirmedShell } from './confirmed-shell-agent-title'
import {
  installAgentDeparture,
  readPaneDepartureState,
  readPaneObservationOwner
} from './agent-departure'
import { isObservationOwnerSuperseded } from '../pane-foreground-agent-tracker-contract'

/** Pane agent identity, foreground-agent sampling, and command lifecycle handling. */
export function installPaneAgentIdentity(session: ConnectPanePtySession): void {
  installPaneTerminalInterfacePresentation(session)
  // Why the shared module: the same ladder answers the 133;D guard, the visible-pane
  // resampler, and the OSC color-reply skip, and it is the one piece of this installer
  // that is a pure rule worth testing on its own.
  const panePane = (): PaneLaunchAgentPaneSlice => ({
    worktreeId: session.deps.worktreeId,
    tabId: session.deps.tabId,
    paneKey: session.cacheKey,
    startup: session.paneStartup
  })
  const resolveLaunchAgentCandidate = (
    state: ReturnType<typeof useAppStore.getState>
  ): string | undefined => resolvePaneLaunchAgentCandidate(state, panePane())
  session.paneExpectsLaunchAgent = (state: ReturnType<typeof useAppStore.getState>): boolean =>
    Boolean(resolveLaunchAgentCandidate(state))
  // Why: the concrete TUI agent a fresh spawn is expected to launch, used to seed
  // a command-start confirmation on no-OSC shells (Git Bash/cmd) that never emit
  // one. Returns null when the expectation isn't a recognized TUI agent.
  session.resolveExpectedLaunchTuiAgent = (): TuiAgent | null => {
    const candidate = resolveLaunchAgentCandidate(useAppStore.getState())
    return isTuiAgent(candidate) ? candidate : null
  }
  // Why: jcode themes itself; answering its OSC color burst can land before its
  // composer is ready and render the reply as pre-typed text (the main-side
  // startup ingress already skips it, the renderer must skip the answer too).
  session.shouldAnswerPaneOscColorQueries = (): boolean =>
    paneShouldAnswerOscColorQueries(useAppStore.getState(), panePane())
  session.clearStaleAgentTabTitleOnConfirmedShell = () =>
    clearStaleAgentTabTitleOnConfirmedShell(session)
  session.deferredCommandFinishedStatusDrop = null
  session.deferredConfirmedShellReconcile = null
  // Accepted status sequence fences async row retirement against a newer owner.
  session.reconcileEndedProcessIfPaneQuiet = (armedAcceptedStatusSeq: number | undefined): void => {
    const current = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    if (current && current.acceptedStatusSeq !== armedAcceptedStatusSeq) {
      return
    }
    // Why: main's clear echoes back and would drop the result the deferred drop just kept.
    if (current && isRetainedProgramResult(current)) {
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
    options: { confirmedShell?: boolean; processExitConfirmed?: boolean } = {}
  ): void => {
    const dropStatus = session.deferredCommandFinishedStatusDrop
    const reconcile = session.deferredConfirmedShellReconcile
    session.deferredConfirmedShellReconcile = null
    if (options.confirmedShell || !dropStatus) {
      session.deferredCommandFinishedStatusDrop = null
      if (options.confirmedShell && dropStatus) {
        dropStatus?.()
        reconcile?.()
      }
      return
    }
    const ptyId = session.transport.getPtyId()
    const incarnation = session.remotePtyIncarnationId
    const owner = readPaneObservationOwner(session)
    const row = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    if (!readPaneDepartureState(session) || (!row && !options.processExitConfirmed)) {
      session.deferredCommandFinishedStatusDrop = null
      return
    }
    const dropUnlessVerifiable = (verifiable: boolean): void => {
      if (session.deferredCommandFinishedStatusDrop !== dropStatus) {
        return
      }
      session.deferredCommandFinishedStatusDrop = null
      const state = readPaneDepartureState(session)
      const current = state?.agentStatusByPaneKey[session.cacheKey]
      if (
        !state ||
        session.transport.getPtyId() !== ptyId ||
        session.remotePtyIncarnationId !== incarnation ||
        isObservationOwnerSuperseded(owner, readPaneObservationOwner(session)) ||
        current?.acceptedStatusSeq !== row?.acceptedStatusSeq ||
        (!current && !options.processExitConfirmed)
      ) {
        return
      }
      if (!verifiable) {
        dropStatus()
        // Why: only a process-table-confirmed exit proves the agent's main-side latches are dead.
        if (options.processExitConfirmed) {
          reconcile?.()
        }
      }
    }
    void Promise.resolve(window.api?.agentStatus?.hasVerifiableAgentProcess?.(session.cacheKey))
      .then((verifiable) => dropUnlessVerifiable(verifiable === true))
      .catch(() => dropUnlessVerifiable(false))
  }
  installAgentDeparture(session)
  session.isForegroundTrackingAllowed = (id: string): boolean => {
    if (isRemoteExecutionHostPtyId(id)) {
      return true
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
    readForegroundProcess: (id, options) =>
      isRemoteExecutionHostPtyId(id)
        ? inspectRuntimeTerminalProcess(id, options)
        : window.api.pty.getForegroundProcess(id),
    confirmForegroundProcess: (id, options) =>
      isRemoteExecutionHostPtyId(id)
        ? inspectRuntimeTerminalProcess(id, options)
        : window.api.pty.confirmForegroundProcess(id),
    isRemotePtyId: isRemoteExecutionHostPtyId,
    getExpectedIncarnationId: () => session.remotePtyIncarnationId ?? null,
    publish: (entry) => useAppStore.getState().setPaneForegroundAgent(session.cacheKey, entry),
    getPublishedEntry: () => useAppStore.getState().paneForegroundAgentByPaneKey[session.cacheKey],
    // Why lazy: the completion coordinator is installed after this tracker.
    onAgentProcessRead: (process) =>
      session.agentCompletionCoordinator?.observeForegroundAgentProcess(process),
    hasKnownAgentIdentity: () =>
      useAppStore.getState().paneForegroundAgentByPaneKey[session.cacheKey]?.agentEvidence ===
      'process-read',
    hasAgentExpectation: () => {
      const state = useAppStore.getState()
      return session.paneExpectsLaunchAgent(state) || session.paneHasKnownAgentIdentity()
    },
    getObservationOwner: () => readPaneObservationOwner(session),
    onConfirmedShellForeground: (reason) => {
      if (reason === 'command-finished') {
        return session.acceptAgentDeparture('command-finished')
      }
      if (!readTerminalInterface(useAppStore.getState(), session.cacheKey)) {
        return session.acceptAgentDeparture('foreground-release')
      }
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
        agentEvidence: foreground.agentEvidence,
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
      session.deferredCommandFinishedStatusDrop =
        entry ||
        state.paneForegroundAgentByPaneKey[session.cacheKey]?.agentEvidence === 'process-read'
          ? dropStatus
          : null
      session.deferredConfirmedShellReconcile = () =>
        session.reconcileEndedProcessIfPaneQuiet(armedAcceptedStatusSeq)
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
    if (!forceRoutingConfirmation && foreground?.shellForeground) {
      return
    }
    // Why: tab launch metadata can leak across split panes; rebuild pane-scoped
    // identity from local process state, with remote/SSH excluded by the tracker.
    session.visibleForegroundSamplePending =
      session.paneForegroundAgentTracker.onVisiblePtyBound(expectsAgent)
  }
  session.startAcceptedInferredCommand = (agent) => {
    session.agentCompletionCoordinator?.invalidateProcessInspection()
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
      !isTuiAgent(foreground.agent) ||
      foreground.routingTrusted !== true ||
      TUI_AGENT_CONFIG[foreground.agent].windowsShiftEnterEncoding !== 'csi-u'
    ) {
      return
    }
    // Why: cmd.exe and Git Bash have no OSC command boundaries. Keep the icon
    // as a hint, but revoke bytes until one current provider confirmation lands.
    useAppStore.getState().setPaneForegroundAgent(session.cacheKey, {
      agent: foreground.agent,
      agentEvidence: foreground.agentEvidence,
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
        agentEvidence: foreground.agentEvidence,
        routingRevoked: true,
        shellForeground: false,
        routingConfirmationPending: true
      })
    }
  }
  session.commandLifecycle = createTerminalCommandLifecycle({
    onCommandStarted: () => {
      session.agentCompletionCoordinator?.invalidateProcessInspection()
      // Why: a new command invalidates cleanup waiting on the previous D; only
      // a later confirmed process exit may retire this pane's live identity.
      session.deferredCommandFinishedStatusDrop = null
      dismissRetainedProgramResult(session.cacheKey, useAppStore.getState())
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
