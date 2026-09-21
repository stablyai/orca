import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import {
  consumeCommittedPtyShutdownExit,
  deferPtyShutdownExit,
  isHostPtySleepPending
} from '../pty-shutdown-exit-deferral'
import { replayIntoTerminal } from '../replay-guard'
import { POST_REPLAY_MODE_RESET } from '../../../../../shared/terminal-mode-reset-profiles'
import { isProvenProcessExit } from '../../../../../shared/terminal-exit-cause'
import {
  getProviderSessionClaimKey,
  isPassiveCompletedHibernationEvidence
} from '@/lib/sleeping-agent-pane-ownership'
import {
  createGitBashConsoleCapacityDetector,
  type GitBashConsoleCapacityDetector
} from '../git-bash-console-capacity'
import type { PtyPaneStartup } from '../pty-connection-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** PTY exit handling, hibernated-pane wake targets, and post-exit focus transfer. */
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
      // Why: when a newborn split PTY dies before output/input, the pane stays
      // mounted for diagnostics; move live focus to the sibling that still owns a PTY.
      session.manager.setActivePane(targetPaneId, {
        focus: session.deps.isActiveRef.current && session.deps.isVisibleRef.current
      })
    }
  }

  // Why: the transport's own exit handler (pty-transport.ts) normally makes
  // onExit run-at-most-once by clearing connected/ptyId + unregistering BEFORE
  // calling it. reconcileIfSessionDead drives onExit directly (bypassing that),
  // so this guards the body so reconcile and any racing real/synthetic pty:exit
  // for the same id close the pane exactly once. Scoped to the exiting ptyId
  // (not a bare boolean): an intentional suppressed restart keeps the pane
  // mounted and rebinds to a NEW ptyId, and that replacement's later real exit
  // must still run — a one-shot boolean would strand the pane on rebind.
  session.handledExitPtyId = null
  // Why: tracks the ptyId of a genuine fresh spawn — onPtySpawn fires only for
  // fresh spawns, never reattach/coldRestore (pty-transport.ts). Lets the
  // sole-pane exit branch tell "this newborn shell died on its own" from "a
  // reattached persisted session was already dead", so a failing .envrc/direnv
  // on a brand-new worktree keeps its dead terminal visible instead of bouncing
  // the user to Landing.
  session.spawnedFreshPtyId = null
  // Why: hibernation suppresses its kill's exit while the pane is hidden, so
  // onExit must not tear the pane down — but the pane still owes the user a
  // wake. Remember the hibernated PTY and exact record; the visibility-resume
  // hook consumes both and cannot accidentally adopt a later stale record.
  session.hibernatedWakeTarget = null
  session.wakeHibernatedAgentPane = null
  // Why: a mobile wake can land after the sleeping record is written but
  // before the suppressed kill exit arms the wake target. The phone never
  // reveals the desktop pane, so without a latch the edge-triggered wake would
  // be dropped and the phone left on a frozen terminal.
  session.pendingHibernatedWakeTarget = null
  // Why: transport.connect settles asynchronously. Repeated mobile activation
  // must keep claiming this provider session until the replacement PTY either
  // exists (and clears the sleep record) or the spawn fails and can be retried.
  session.hibernatedWakeInFlightClaimKey = null
  // Why: reveal is the normal wake trigger, but a reveal that lands *during* the
  // in-flight hibernation kill runs noteVisibilityResume before onExit arms the
  // wake. Sharing the guarded consume lets both the reveal hook and the
  // arm-time foreground check resume the pane exactly once.
  session.consumeHibernatedAgentWake = (claimedProviderSessions?: Set<string>): string | null => {
    const target = session.hibernatedWakeTarget
    if (!target || session.disposed) {
      return null
    }
    if (session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport) {
      return null
    }
    const currentRecord = session.getSleepingRecordForPane(useAppStore.getState())?.record
    if (currentRecord !== target.record) {
      session.hibernatedWakeTarget = null
      session.pendingHibernatedWakeTarget = null
      return null
    }
    const currentPtyId = session.transport.getPtyId()
    // Why: a real pty:exit clears the transport's ptyId before onExit while a
    // reconcile-driven exit leaves it bound; both mean "nothing respawned since
    // hibernation". A different non-null id means another flow (e.g. an
    // intentional restart) already rebound the pane — its spawn wins.
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
    // Why: one wake event can visit multiple mounted legacy/stable panes for
    // the same provider session. Claim synchronously before any spawn starts.
    claimedProviderSessions?.add(claimKey)
    session.hibernatedWakeTarget = null
    session.pendingHibernatedWakeTarget = null
    session.hibernatedWakeInFlightClaimKey = claimKey
    // Why: reveal is the wake signal for a hibernated pane. Resume the recorded
    // agent session (or fall back to a fresh shell) instead of leaving the
    // frozen frame with no PTY behind it.
    void session
      .wakeHibernatedAgentPane()
      .then((spawnedPtyId) => {
        if (!spawnedPtyId) {
          // Why: a transient replacement-spawn failure leaves the passive
          // record owned by this pane. Re-arm the exact target so a later
          // mobile open can retry instead of stranding the frozen session;
          // consume revalidates disposal, binding, PTY, and record identity.
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
      // Why: an old transport can deliver a late exit after this pane has
      // rebound to a replacement PTY; only clear ownership for the exited id.
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
    const processExitState =
      session.processExitStateByPtyId.get(ptyId) ?? session.currentProcessExitState
    session.processExitStateByPtyId.delete(ptyId)
    session.agentCompletionCoordinator.dispose()
    session.dropSideEffectFactConsumer()
    // Why: main clears gate state on PTY exit too; this only resets the
    // pane-local marker so a reused pane cannot skip re-marking a new PTY.
    session.releaseHiddenRendererPtyDelivery()
    // A synthetic host-loss exit only retires this transport. Keep the mounted
    // leaf↔PTY identity so reconnect/replay can adopt it after the host returns.
    if (!isUnverifiedExit) {
      session.clearPanePtyFitBinding()
    }
    // Why: the negotiating application died with its PTY; any replacement
    // session starts with kitty keyboard flags at zero.
    session.kittyKeyboardModes.reset()
    const isSuppressedExit = session.deps.consumeSuppressedPtyExit(ptyId) || preserveRendererBinding
    if (!isSuppressedExit && !isUnverifiedExit) {
      session.clearExitedPanePtyLayoutBinding(ptyId)
    }
    session.deps.clearRuntimePaneTitle(session.deps.tabId, session.pane.id)
    if (!preserveRendererBinding && !isUnverifiedExit) {
      session.deps.clearTabPtyId(session.deps.tabId, ptyId)
    }
    // Why: if the PTY exits abruptly (Ctrl-D, crash, shell termination) without
    // first emitting a non-agent title, the cache timer would persist as stale
    // state. Clear it unconditionally on PTY exit.
    session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    // Why: a dead terminal has no running agent — remove its explicit status
    // entry so the hover UI only shows what is running *now*.
    useAppStore.getState().removeAgentStatus(session.cacheKey)
    useAppStore.getState().clearPaneForegroundAgent(session.cacheKey)
    // The runtime graph is the CLI's source for live terminal bindings, so
    // we must republish when a pane loses its PTY instead of waiting for a
    // broader layout change that may never happen.
    scheduleRuntimeGraphSync()
    if (isUnverifiedExit && !isSuppressedExit) {
      // The tab-level owner records liveness as unknown and leaves the row in
      // place. This must happen before the split/sole-pane close branches.
      session.manager.setPaneGpuRendering(session.pane.id, true)
      session.deps.onPtyExitRef.current(ptyId, exitCode)
      return
    }
    // Why: intentional restarts suppress the PTY exit ahead of time so the
    // pane stays mounted and can reconnect in place. Without consuming the
    // suppression here, split-pane Codex restarts would still close the pane
    // because this handler runs before the tab-level close logic sees the exit.
    if (isSuppressedExit) {
      // Why: the action that suppressed the exit owns whether the leaf binding
      // is a wake hint or should be discarded; runtime cleanup above is enough.
      session.manager.setPaneGpuRendering(session.pane.id, true)
      const sleepingRecordEntry = session.getSleepingRecordForPane(useAppStore.getState())
      if (
        sleepingRecordEntry &&
        isPassiveCompletedHibernationEvidence(sleepingRecordEntry.record)
      ) {
        // Why: hibernation killed this pane's PTY while hidden. The frozen TUI
        // frame still has mouse-tracking/bracketed-paste armed, which silently
        // eats every click and keystroke against a dead transport — disarm the
        // modes now and arm the reveal-time wake.
        replayIntoTerminal(session.pane, session.deps.replayingPanesRef, POST_REPLAY_MODE_RESET, {
          breadcrumbIdentity: {
            tabId: session.deps.tabId,
            worktreeId: session.deps.worktreeId,
            ptyId
          },
          shouldRefreshViewportSynchronously: session.shouldRefreshForegroundSynchronously
        })
        session.hibernatedWakeTarget = { ptyId, record: sleepingRecordEntry.record }
        const pendingWakeMatches =
          session.pendingHibernatedWakeTarget?.ptyId === ptyId &&
          session.pendingHibernatedWakeTarget.record === sleepingRecordEntry.record
        if (session.pendingHibernatedWakeTarget && !pendingWakeMatches) {
          session.pendingHibernatedWakeTarget = null
        }
        if (session.deps.isVisibleRef.current || pendingWakeMatches) {
          // Why: a reveal (or a mobile wake) that raced this kill already ran
          // before the exit landed, so it saw nothing armed. Consume the wake
          // now (deferred off the exit handler) so the pane still resumes
          // without needing a second hide/reveal or wake event.
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
    const failedLocalProcess =
      !session.connectionId && session.runtimeEnvironmentId === null && exitCode !== 0
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
      // Why: a worktree's sole newborn terminal can die on shell startup — e.g.
      // a PR branch ships an .envrc whose direnv command fails, so the login
      // shell exits non-zero immediately. Routing that through onPtyExitRef
      // closes the only tab, which deactivates the worktree (setActiveWorktree
      // (null)) and strands the user on the Landing screen for a worktree that
      // was just created. Keep the dead pane mounted instead (mirrors the
      // freshly-split guard below) so the direnv error stays visible and the
      // worktree stays active. Gated on a genuine fresh spawn (onPtySpawn fired
      // for this ptyId — reattach/coldRestore skip it) that the user never typed
      // into, so a reattached-dead session or an explicit `exit` still tears
      // down as before.
      if (session.spawnedFreshPtyId === ptyId && !Number.isFinite(session.lastTerminalInputAt)) {
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
      // Why: a freshly split pane can lose its newborn PTY during setup; keep
      // the split visible so the failed session does not immediately collapse.
      // Hidden panes must close instead: the hidden-delivery gate withholds
      // their bytes, so "no output" is meaningless there, and keeping one
      // strands a binding-less pane the exit path never revisits — it remounts
      // as a permanently blank ghost on reveal.
      session.focusSurvivingPtyPaneAfterKeptExit()
      return
    }
    session.manager.closePane(session.pane.id)
  }

  // Why: on app restart, restored Claude tabs may already be idle when we first
  // see their title. The agent status tracker only fires onBecameIdle for
  // working→idle transitions, so the cache timer would never start for these
  // sessions. We only allow this one-time seed for reattached PTYs; fresh
  // Claude launches also start idle, but they have no prompt cache yet.
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
