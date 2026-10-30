import { isPaneForegroundTrackingAllowed } from './terminal-foreground-tracking'
import { captureTerminalFactSubject } from '../terminal-fact-subject'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import {
  createTerminalForegroundPublication,
  requestTerminalForegroundReconfirmation,
  type TerminalForegroundServices
} from './terminal-foreground-services'
import { dismissRetainedProgramResult } from '@/lib/program-status/result-retention'
import { isRetainedProgramResult } from '@/lib/program-status/row'
import { useAppStore } from '@/store'
import { createTerminalCommandLifecycle } from '../terminal-command-lifecycle'
import { createPaneForegroundAgentTracker } from '../pane-foreground-agent-tracker'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'

import { createTerminalLaunchAgentPolicy } from './terminal-launch-agent-policy'

export function createTerminalForegroundPolicy(services: TerminalForegroundServices) {
  const publication = createTerminalForegroundPublication(services)
  const {
    paneHasLiveHookAgentIcon,
    paneExpectsLaunchAgent,
    resolveExpectedLaunchTuiAgent,
    shouldAnswerPaneOscColorQueries
  } = createTerminalLaunchAgentPolicy(services)
  // Why: a launched/hook-known agent pane must confirm — not trust — a 133;D so a
  // full-screen agent's leaked nested-shell 133;D can't clear its tab identity,
  // even on a restore where no command-start read has recorded evidence yet.
  const paneHasKnownAgentIdentity = (): boolean => {
    const state = useAppStore.getState()
    const registeredLaunchAgent =
      state.agentLaunchConfigByPaneKey[services.paneKey]?.identity?.agentType
    return (
      Boolean(state.paneForegroundAgentByPaneKey[services.paneKey]?.agent) ||
      paneHasLiveHookAgentIcon(state) ||
      isTuiAgent(registeredLaunchAgent)
    )
  }
  let deferredCommandFinishedStatusDrop: (() => void) | null = null
  let deferredConfirmedShellReconcile: (() => void) | null = null
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
    const current = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
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
    window.api?.agentStatus?.reconcileEndedProcess?.(services.paneKey)
  }
  let visibleForegroundSamplePending = false
  let visibleForegroundSampleSettled = false
  const settleDeferredCommandFinishedStatusDrop = (
    options: { confirmedShell?: boolean; processExitConfirmed?: boolean } = {}
  ): void => {
    const dropStatus = deferredCommandFinishedStatusDrop
    const reconcile = deferredConfirmedShellReconcile
    deferredConfirmedShellReconcile = null
    if (options.confirmedShell || !dropStatus) {
      deferredCommandFinishedStatusDrop = null
      if (options.confirmedShell) {
        dropStatus?.()
        reconcile?.()
      }
      return
    }
    // Host-verifiable owners retain rows on unanswered reads; other panes keep cleanup. Keep the drop armed so a new command can cancel it.
    const dropUnlessVerifiable = (verifiable: boolean): void => {
      if (deferredCommandFinishedStatusDrop !== dropStatus) {
        return
      }
      deferredCommandFinishedStatusDrop = null
      if (!verifiable) {
        dropStatus()
        // Why: only a process-table-confirmed exit proves the agent's main-side latches are dead.
        if (options.processExitConfirmed) {
          reconcile?.()
        }
      }
    }
    void Promise.resolve(window.api?.agentStatus?.hasVerifiableAgentProcess?.(services.paneKey))
      .then((verifiable) => dropUnlessVerifiable(verifiable === true))
      .catch(() => dropUnlessVerifiable(false))
  }
  const isForegroundTrackingAllowed = (id: string): boolean =>
    isPaneForegroundTrackingAllowed(id, services)
  const paneForegroundAgentTracker = createPaneForegroundAgentTracker({
    getPtyId: () => (publication.applicable() ? services.getPtyId() : null),
    captureRead: publication.captureRead,
    demote: publication.demote,
    isTrackablePtyId: isForegroundTrackingAllowed,
    readForegroundProcess: (id, options) =>
      isRemoteExecutionHostPtyId(id)
        ? inspectRuntimeTerminalProcess(id, options)
        : window.api.pty.getForegroundProcess(id),
    confirmForegroundProcess: (id, options) =>
      isRemoteExecutionHostPtyId(id)
        ? inspectRuntimeTerminalProcess(id, options)
        : window.api.pty.confirmForegroundProcess(id),
    isRemotePtyId: isRemoteExecutionHostPtyId,
    getExpectedIncarnationId: () => services.getExpectedIncarnationId(),
    publish: publication.publish,
    getPublishedEntry: publication.current,
    // Why lazy: the completion coordinator is installed after this tracker.
    onAgentProcessRead: (process) => services.observeForegroundAgentProcess(process),
    hasKnownAgentIdentity: paneHasKnownAgentIdentity,
    onConfirmedShellForeground: (reason) => {
      services.onConfirmedShellForeground(reason)
      if (reason === 'process-exit') {
        visibleForegroundSamplePending = false
        visibleForegroundSampleSettled = false
      }
      if (reason !== 'process-exit') {
        settleDeferredCommandFinishedStatusDrop({ confirmedShell: true })
      }
    },
    // Why wrapped: passed bare, a caller-supplied argument would be read as `options` and could
    // reconcile on the unavailable path, which has no proof the agent exited.
    onCommandFinishedUnavailable: () => settleDeferredCommandFinishedStatusDrop(),
    onVisibleForegroundSettled: (outcome) => {
      visibleForegroundSamplePending = false
      visibleForegroundSampleSettled = outcome !== 'inconclusive'
      if (outcome !== 'inconclusive') {
        return
      }
      settleDeferredCommandFinishedStatusDrop()
      const foreground = useAppStore.getState().paneForegroundAgentByPaneKey[services.paneKey]
      if (foreground?.routingConfirmationPending !== true) {
        return
      }
      publication.publish({
        ...foreground,
        routingTrusted: undefined,
        routingConfirmationPending: undefined,
        routingRevoked: true,
        shellForeground: foreground.shellForeground
      })
    }
  })
  // Why: one command-finished policy whether the signal arrives as bytes
  // (remote PTYs, kill switch off) or as a main-derived pty:sideEffect fact —
  // routing both through this handler keeps the drop/interrupt semantics
  // identical across authority modes.
  const finishCapturedCommand = (
    bestEffortExitCode: number | null,
    entry: AgentStatusEntry | undefined,
    canApply = () => true
  ): void => {
    const subject = captureTerminalFactSubject(services.paneKey)
    let cleanupLaunch = subject.launch
    visibleForegroundSamplePending = false
    const parkedRemote = !services.isVisible() && isRemoteExecutionHostPtyId(services.getPtyId())
    if (parkedRemote) {
      paneForegroundAgentTracker.suspend()
    }
    const shouldDeferStatusDrop = parkedRemote || paneForegroundAgentTracker.onCommandFinished()
    // Why: the finished command may have moved HEAD or the index (e.g.
    // `git checkout`); nudge git UI now instead of waiting for a poll.
    dispatchTerminalCommandFinishedEvent(services.worktreeId, bestEffortExitCode)
    const inferenceResult = services.flushPendingInterruptInference()
    const applyDrop = (allowInferredInterrupt = false): void => {
      if (useAppStore.getState().agentLaunchConfigByPaneKey[services.paneKey] !== subject.launch) {
        return
      }
      services.dropCommandFinishedStatusIfSameTurn(entry, { subject, allowInferredInterrupt })
      cleanupLaunch = useAppStore.getState().agentLaunchConfigByPaneKey[services.paneKey]
    }
    const dropStatus = (): void => {
      if (!canApply()) {
        return
      }
      if (inferenceResult === true) {
        applyDrop(true)
        return
      }
      if (inferenceResult instanceof Promise) {
        void inferenceResult.then((applied) => {
          if (!canApply()) {
            return
          }
          applyDrop(applied === true)
        })
        return
      }
      applyDrop()
    }
    if (shouldDeferStatusDrop) {
      // Retain identity through local shell confirmation, anchoring accepted-status ordinal once across the whole retry ladder.
      const armedAcceptedStatusSeq = entry?.acceptedStatusSeq
      deferredCommandFinishedStatusDrop = dropStatus
      deferredConfirmedShellReconcile = () => {
        if (
          canApply() &&
          useAppStore.getState().agentLaunchConfigByPaneKey[services.paneKey] === cleanupLaunch
        ) {
          reconcileEndedProcessIfPaneQuiet(armedAcceptedStatusSeq)
        }
      }
      return
    }
    deferredCommandFinishedStatusDrop = null
    deferredConfirmedShellReconcile = null
    dropStatus()
  }
  const handleCommandFinished = (exitCode: number | null): void =>
    finishCapturedCommand(exitCode, useAppStore.getState().agentStatusByPaneKey[services.paneKey])
  const sampleVisiblePaneForegroundAgent = (forceRoutingConfirmation = false): void => {
    if (!services.isVisible() || visibleForegroundSamplePending || visibleForegroundSampleSettled) {
      return
    }
    const state = useAppStore.getState()
    const foreground = state.paneForegroundAgentByPaneKey[services.paneKey]
    // Why: a daemon reattach may restore display identity without current
    // routing authority. Only fresh evidence can suppress its confirmation.
    if (foreground?.agent && foreground.routingTrusted === true) {
      return
    }
    if (!forceRoutingConfirmation && paneHasLiveHookAgentIcon(state)) {
      return
    }
    const expectsAgent = paneExpectsLaunchAgent(state)
    // Why: a completed local process ladder is stronger than stale tab/startup
    // launch metadata. Command-start clears this mark if the pane becomes busy.
    if (foreground?.shellForeground) {
      return
    }
    // Why: tab launch metadata can leak across split panes; rebuild pane-scoped
    // identity from local process state, with remote/SSH excluded by the tracker.
    visibleForegroundSamplePending = paneForegroundAgentTracker.onVisiblePtyBound(expectsAgent)
  }
  const requestKnownWindowsShiftEnterReconfirmation = () =>
    requestTerminalForegroundReconfirmation(publication, paneForegroundAgentTracker, () => {
      visibleForegroundSamplePending = false
      visibleForegroundSampleSettled = false
      sampleVisiblePaneForegroundAgent(true)
    })
  const requestAcceptedInputDiscovery = (): void => {
    deferredCommandFinishedStatusDrop = null
    deferredConfirmedShellReconcile = null
    requestKnownWindowsShiftEnterReconfirmation()
    visibleForegroundSamplePending = false
    visibleForegroundSampleSettled = false
    paneForegroundAgentTracker.onAcceptedInputBoundary()
  }
  const handleCommandStarted = (): void => {
    // Why: a new command invalidates cleanup waiting on the previous D; only
    // a later confirmed shell boundary may retire this pane's live identity.
    deferredCommandFinishedStatusDrop = null
    dismissRetainedProgramResult(services.paneKey, useAppStore.getState())
    visibleForegroundSamplePending = false
    visibleForegroundSampleSettled = false
    paneForegroundAgentTracker.onCommandStarted()
  }
  const commandLifecycle = createTerminalCommandLifecycle({
    onCommandStarted: handleCommandStarted,
    onCommandFinished: handleCommandFinished
  })
  return {
    publication,
    paneHasLiveHookAgentIcon,
    paneExpectsLaunchAgent,
    resolveExpectedLaunchTuiAgent,
    shouldAnswerPaneOscColorQueries,
    paneHasKnownAgentIdentity,
    get deferredCommandFinishedStatusDrop() {
      return deferredCommandFinishedStatusDrop
    },
    set deferredCommandFinishedStatusDrop(value: (() => void) | null) {
      deferredCommandFinishedStatusDrop = value
    },
    get deferredConfirmedShellReconcile() {
      return deferredConfirmedShellReconcile
    },
    set deferredConfirmedShellReconcile(value: (() => void) | null) {
      deferredConfirmedShellReconcile = value
    },
    reconcileEndedProcessIfPaneQuiet,
    get visibleForegroundSamplePending() {
      return visibleForegroundSamplePending
    },
    set visibleForegroundSamplePending(value: boolean) {
      visibleForegroundSamplePending = value
    },
    get visibleForegroundSampleSettled() {
      return visibleForegroundSampleSettled
    },
    set visibleForegroundSampleSettled(value: boolean) {
      visibleForegroundSampleSettled = value
    },
    settleDeferredCommandFinishedStatusDrop,
    isForegroundTrackingAllowed,
    paneForegroundAgentTracker,
    handleCommandFinished,
    finishCapturedCommand,
    sampleVisiblePaneForegroundAgent,
    requestAcceptedInputDiscovery,
    requestKnownWindowsShiftEnterReconfirmation,
    handleCommandStarted,
    commandLifecycle
  }
}
