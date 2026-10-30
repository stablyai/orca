import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import {
  consumeCommittedPtyShutdownExit,
  deferPtyShutdownExit,
  isHostPtySleepPending
} from '../pty-shutdown-exit-deferral'
import { POST_REPLAY_MODE_RESET } from '../../../../../shared/terminal-mode-reset-profiles'
import { isProvenProcessExit } from '../../../../../shared/terminal-exit-cause'
import { getProviderSessionClaimKey } from '@/lib/sleeping-agent-pane-ownership'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import { agentTurnEndedUncleanly } from '../../../../../shared/agent-main-agent-verdict'
import {
  createGitBashConsoleCapacityDetector,
  type GitBashConsoleCapacityDetector
} from '../git-bash-console-capacity'
import type { PtyPaneStartup } from '../pty-connection-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { isPtyExitReplacedByRestart } from '../pty-exit-delivery'
import { armRestartReplacement } from './restart-replacement-on-show'
import { noteHiddenAgentResumePtyEnded } from './hidden-agent-resume-deferral'
import { expectExitedSplitPaneClose } from './exited-split-pane-close'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'

// Why live+done arms too: kept from #16308's wake-sweep widening; hibernation itself only writes worktree-sleep notes.
export function noteArmsHibernatedPaneWake(record: SleepingAgentSessionRecord): boolean {
  return (
    record.state === 'done' &&
    record.origin !== 'quit' &&
    !(record.origin === 'live' && agentTurnEndedUncleanly(record))
  )
}

/** A tab's sole pane keeps a dead terminal it freshly spawned and the user never typed into. */
function keepsUntouchedFreshPane(session: ConnectPanePtySession, ptyId: string): boolean {
  return session.spawnedFreshPtyId === ptyId && !Number.isFinite(session.lastTerminalInputAt)
}

export function installPtyExitHibernate(session: ConnectPanePtySession): void {
  type ProcessExitState = {
    startup: PtyPaneStartup
    detector: GitBashConsoleCapacityDetector
  }
  session.createProcessExitState = (startup: PtyPaneStartup): ProcessExitState => ({
    startup,
    detector: createGitBashConsoleCapacityDetector()
  })
  session.currentProcessExitState = session.createProcessExitState(session.paneStartup)
  session.processExitStateByPtyId = new Map<string, ProcessExitState>()
  session.bindProcessExitState = (ptyId: string, replacedPtyId?: string): void => {
    const state =
      (replacedPtyId ? session.processExitStateByPtyId.get(replacedPtyId) : undefined) ??
      session.currentProcessExitState
    session.processExitStateByPtyId.set(ptyId, state)
    if (replacedPtyId && replacedPtyId !== ptyId) {
      session.processExitStateByPtyId.delete(replacedPtyId)
    }
  }
  session.focusSurvivingPtyPaneAfterKeptExit = (): void => {
    if (session.manager.getActivePane()?.id !== session.pane.id) {
      return
    }
    const hasPtyBinding = (paneId: number): boolean =>
      Boolean(session.deps.paneTransportsRef.current.get(paneId)?.getPtyId())
    const repairedActiveLeafId =
      useAppStore.getState().terminalLayoutsByTabId[session.deps.tabId]?.activeLeafId ?? null
    const repairedActivePaneId = repairedActiveLeafId
      ? session.manager.getNumericIdForLeaf(repairedActiveLeafId)
      : null
    const targetPaneId =
      repairedActivePaneId !== null &&
      repairedActivePaneId !== session.pane.id &&
      hasPtyBinding(repairedActivePaneId)
        ? repairedActivePaneId
        : (session.manager
            .getPanes()
            .find((candidate) => candidate.id !== session.pane.id && hasPtyBinding(candidate.id))
            ?.id ?? null)
    if (targetPaneId !== null) {
      // Retain newborn split failures for diagnostics, moving focus to a sibling with a live PTY.
      session.manager.setActivePane(targetPaneId, {
        focus: session.deps.isActiveRef.current && session.deps.isVisibleRef.current
      })
    }
  }

  // Deduplicate direct reconcile and transport exits by PTY ID; a later replacement ID must retain its own exit handling.
  session.handledExitPtyId = null
  // Only genuine fresh, never-typed PTYs keep startup errors visible; dead reattached sessions must still close normally.
  session.spawnedFreshPtyId = null
  // Suppressed hidden hibernation exits still owe a wake; retain the exact PTY/record so a later session cannot be adopted.
  session.hibernatedWakeTarget = null
  session.wakeHibernatedAgentPane = null
  // Latch mobile wakes between record write and kill-exit arming; mobile never reveals the desktop to retry the lost edge.
  session.pendingHibernatedWakeTarget = null
  // Claim the provider session throughout async replacement spawn so repeated mobile activation cannot duplicate resume.
  session.hibernatedWakeInFlightClaimKey = null
  // Share guarded wake consumption between reveal and arm-time visibility checks so a reveal racing kill resumes exactly once.
  session.consumeHibernatedAgentWake = (claimedProviderSessions?: Set<string>): string | null => {
    const target = session.hibernatedWakeTarget
    if (!target || session.disposed) {
      return null
    }
    if (session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport) {
      return null
    }
    const currentRecord = session.getSleepingRecordForPane(useAppStore.getState())?.record
    // Why claim keys: a held pane can wait a whole session, and a re-capture of the same session must not strand it.
    if (
      !currentRecord ||
      getProviderSessionClaimKey(currentRecord) !== getProviderSessionClaimKey(target.record)
    ) {
      session.hibernatedWakeTarget = null
      session.pendingHibernatedWakeTarget = null
      return null
    }
    const currentPtyId = session.transport.getPtyId()
    // Null or the old PTY means no replacement; a different bound ID proves another flow already owns the pane.
    if (currentPtyId !== null && currentPtyId !== target.ptyId) {
      session.hibernatedWakeTarget = null
      session.pendingHibernatedWakeTarget = null
      return null
    }
    if (!session.wakeHibernatedAgentPane) {
      return null
    }
    const claimKey = getProviderSessionClaimKey(target.record)
    if (claimedProviderSessions?.has(claimKey)) {
      return null
    }
    // Claim synchronously before spawn because one wake visits multiple aliases of the same provider session.
    claimedProviderSessions?.add(claimKey)
    session.hibernatedWakeTarget = null
    session.pendingHibernatedWakeTarget = null
    session.hibernatedWakeInFlightClaimKey = claimKey
    // Reveal must resume the recorded session or fresh shell behind the otherwise frozen frame.
    const wake: () => Promise<string | null> = target.wake ?? session.wakeHibernatedAgentPane
    void wake()
      .then((spawnedPtyId) => {
        if (!spawnedPtyId) {
          // On transient spawn failure, re-arm the exact retained record so later mobile wakes can retry after full ownership validation.
          session.hibernatedWakeTarget = target
        }
      })
      .finally(() => {
        if (session.hibernatedWakeInFlightClaimKey === claimKey) {
          session.hibernatedWakeInFlightClaimKey = null
        }
      })
    return claimKey
  }
  session.onExit = (
    ptyId: string,
    exitCode = 0,
    opts: { preserveRendererBinding?: boolean } = {}
  ): void => {
    if (session.handledExitPtyId === ptyId) {
      return
    }
    if (
      session.deps.isPtyShutdownPending(ptyId) ||
      isHostPtySleepPending(ptyId, session.runtimeEnvironmentId)
    ) {
      // Why: the transport emits exit once; replay it only after a verified commit so rollback keeps renderer state retryable.
      deferPtyShutdownExit(ptyId, (settlement) => {
        if (settlement === 'committed') {
          session.onExit(ptyId, exitCode, { preserveRendererBinding: true })
        }
      })
      return
    }
    const isUnverifiedExit = !isProvenProcessExit(exitCode)
    const preserveRendererBinding =
      opts.preserveRendererBinding === true ||
      consumeCommittedPtyShutdownExit(ptyId, session.runtimeEnvironmentId)
    session.resetRendererOrderedSeqForPtyExit(ptyId)
    const currentPaneTransport = session.deps.paneTransportsRef.current.get(session.pane.id)
    if (currentPaneTransport && currentPaneTransport !== session.transport) {
      // Late exits from replaced transports may clear only the exiting PTY’s ownership.
      session.handledExitPtyId = ptyId
      session.processExitStateByPtyId.delete(ptyId)
      if (!preserveRendererBinding && !isUnverifiedExit) {
        session.deps.clearTabPtyId(session.deps.tabId, ptyId)
      }
      session.deps.consumeSuppressedPtyExit(ptyId)
      scheduleRuntimeGraphSync()
      return
    }
    session.handledExitPtyId = ptyId
    noteHiddenAgentResumePtyEnded(session)
    const processExitState =
      session.processExitStateByPtyId.get(ptyId) ?? session.currentProcessExitState
    session.processExitStateByPtyId.delete(ptyId)
    session.agentCompletionCoordinator.dispose()
    session.dropSideEffectFactConsumer()
    // Clear the local mark too so a rebound PTY cannot skip hidden gating.
    session.releaseHiddenRendererPtyDelivery()
    const replacedByRestart = isPtyExitReplacedByRestart(ptyId)
    // Synthetic host loss preserves leaf↔PTY identity for reconnect; confirmed restart death permits replacement as a first spawn.
    if (!isUnverifiedExit || replacedByRestart) {
      session.clearPanePtyFitBinding()
    }
    const isSuppressedExit =
      session.deps.consumeSuppressedPtyExit(ptyId) || preserveRendererBinding || replacedByRestart
    if (!isSuppressedExit && !isUnverifiedExit) {
      session.clearExitedPanePtyLayoutBinding(ptyId)
    }
    session.deps.clearRuntimePaneTitle(session.deps.tabId, session.pane.id)
    if (!preserveRendererBinding && !isUnverifiedExit) {
      session.deps.clearTabPtyId(session.deps.tabId, ptyId)
    }
    // Abrupt exits may omit title reset; always clear the cache countdown.
    session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    useAppStore.getState().removeAgentStatus(session.cacheKey)
    useAppStore.getState().clearPaneForegroundAgent(session.cacheKey)
    // Republish PTY loss to the runtime graph immediately; CLI bindings cannot wait for an unrelated layout change.
    scheduleRuntimeGraphSync()
    if (isUnverifiedExit && !isSuppressedExit) {
      // Record unknown liveness before any close branch can remove the row.
      session.manager.setPaneGpuRendering(session.pane.id, true)
      session.deps.onPtyExitRef.current(ptyId, exitCode)
      return
    }
    // Consume intentional-exit suppression before split close logic so in-place restart keeps its pane.
    if (isSuppressedExit) {
      // Why: the action that suppressed the exit owns whether the leaf binding
      // is a wake hint or should be discarded; runtime cleanup above is enough.
      session.manager.setPaneGpuRendering(session.pane.id, true)
      if (replacedByRestart) {
        // Nothing else will replace this process; the pane takes it back when shown.
        armRestartReplacement(session, ptyId)
        return
      }
      const sleepingRecordEntry = session.getSleepingRecordForPane(useAppStore.getState())
      if (sleepingRecordEntry && noteArmsHibernatedPaneWake(sleepingRecordEntry.record)) {
        // Disarm input-eating modes on the dead frozen TUI, then arm its reveal wake.
        session.writeInputModeGround(POST_REPLAY_MODE_RESET)
        session.hibernatedWakeTarget = { ptyId, record: sleepingRecordEntry.record }
        const pendingWakeMatches =
          session.pendingHibernatedWakeTarget?.ptyId === ptyId &&
          session.pendingHibernatedWakeTarget.record === sleepingRecordEntry.record
        if (session.pendingHibernatedWakeTarget && !pendingWakeMatches) {
          session.pendingHibernatedWakeTarget = null
        }
        if (session.deps.isVisibleRef.current || pendingWakeMatches) {
          // Consume wake after exit if reveal/mobile activation already raced arming; a second user event must not be required.
          queueMicrotask(() => {
            session.consumeHibernatedAgentWake()
          })
        }
      } else if (session.pendingHibernatedWakeTarget?.ptyId === ptyId) {
        session.pendingHibernatedWakeTarget = null
      }
      return
    }
    session.manager.setPaneGpuRendering(session.pane.id, true)
    const failedLocalProcess = session.runtimeEnvironmentId === null && exitCode !== 0
    if (failedLocalProcess && session.deps.onPaneProcessDied) {
      const gitBashConsoleCapacityFailure = processExitState.detector.detected()
      session.deps.onPaneProcessDied({
        paneId: session.pane.id,
        exitCode,
        startup: gitBashConsoleCapacityFailure ? processExitState.startup : null,
        reason: gitBashConsoleCapacityFailure ? 'git-bash-console-capacity' : 'process-failed'
      })
      return
    }
    const panes = session.manager.getPanes()
    if (panes.length <= 1) {
      // Keep sole fresh, never-typed shell failures visible for diagnostics instead of closing the tab and deactivating the workspace; explicit exit and dead reattach still close.
      if (keepsUntouchedFreshPane(session, ptyId)) {
        return
      }
      session.deps.onPtyExitRef.current(ptyId, exitCode)
      return
    }
    if (
      session.deps.isVisibleRef.current &&
      session.hadExistingPaneTransportAtConnect &&
      !session.restoredPtyIdForTransport &&
      !Number.isFinite(session.lastTerminalInputAt) &&
      !session.hasReceivedPtyOutput
    ) {
      // Keep visible newborn split failures; hidden no-output proves nothing under delivery gating and would strand a blank ghost pane.
      session.focusSurvivingPtyPaneAfterKeptExit()
      return
    }
    // Switch point: main closes the exited pane; the window removes it when main's frame does.
    if (
      ORCA_LAYOUT_OWNER_IS_MAIN &&
      expectExitedSplitPaneClose({
        worktreeId: session.deps.worktreeId,
        tabId: session.deps.tabId,
        leafId: session.manager.getLeafId(session.pane.id)
      })
    ) {
      return
    }
    session.manager.closePane(session.pane.id)
  }

  // Seed idle cache timing only on reattach; already-idle restored Claude emits no transition, while fresh idle launches have no prompt cache.
  session.hasConsideredInitialCacheTimerSeed = false
  session.allowInitialIdleCacheSeed = false

  session.resolveCurrentAgentStatusRouting = () => {
    const ptyId = session.activePanePtyBinding ?? session.transport.getPtyId()
    const state = useAppStore.getState()
    if (session.disposed || !ptyId) {
      return undefined
    }
    return resolveLiveAgentStatusConnectionRouting({
      state,
      paneKey: session.cacheKey,
      ptyId,
      expectedConnectionId: session.worktreeConnectionId,
      runtimeEnvironmentId:
        session.transport.getRuntimeEnvironmentId?.() ?? session.runtimeEnvironmentId
    })
  }
}
