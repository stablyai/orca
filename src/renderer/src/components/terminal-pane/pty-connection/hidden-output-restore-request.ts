import { useAppStore } from '@/store'
import { isTerminalWritePipelineCertifiedDead } from '@/lib/pane-manager/terminal-write-pipeline-health'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import { registerStaleDocumentVisibilityRecovery } from '../stale-document-visibility'
import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
import { registerTerminalBacklogRecovery } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import {
  cancelScheduledHiddenOutputRestore,
  scheduleHiddenOutputRestore
} from '../hidden-output-restore-scheduler'
import { resolveHiddenRestoreScrollbackRows } from '../terminal-hidden-restore-scrollback'

import {
  HIDDEN_OUTPUT_RESTORE_MAX_LOOP_ITERATIONS,
  HIDDEN_OUTPUT_RESTORE_REMOTE_OUTCOME_MAX_ATTEMPTS,
  HIDDEN_OUTPUT_RESTORE_LOCAL_GATE_MAX_ATTEMPTS
} from './hidden-output-restore-limits'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { restoredSnapshotPaintsPrintableContent } from '../restored-snapshot-coverage'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { HiddenOutputSnapshotResult } from './hidden-output-snapshot-serialize'

export function bindHiddenOutputRestoreRequest(session: ConnectPanePtySession): void {
  session.requestHiddenOutputRestoreIfNeeded = function (opts?: {
    bypassScheduler?: boolean
  }): boolean {
    // Why: once the write pipeline is probe-certified dead a restore can never parse; recovery owns the pane and the remount gets a fresh xterm + restore.
    if (isTerminalWritePipelineCertifiedDead(session.pane.terminal)) {
      // Why the re-kick: certification's recovery request can be budget-declined or cancelled by a sibling remount; without this, a revealed dead pane keeps the stale frame forever.
      if (!session.certifiedDeadRestoreRecoveryRequested && !session.disposed) {
        session.certifiedDeadRestoreRecoveryRequested = true
        const storePtyId = useAppStore.getState().ptyIdsByTabId?.[session.deps.tabId]?.[0] ?? null
        void requestTerminalPaneRecovery({
          tabId: session.deps.tabId,
          ptyId: session.transport.getPtyId() ?? storePtyId,
          reason: 'restore-blocked',
          terminalRecoveryGeneration: session.terminalRecoveryGeneration,
          terminalRecoveryInstanceId: session.terminalRecoveryInstance.id
        })
      }
      return false
    }
    session.resetHiddenOutputRestoreIfPtyChanged()
    const ptyId = session.hiddenOutputRestorePtyId ?? session.transport.getPtyId()
    if (
      !session.hiddenOutputRestoreNeeded &&
      session.hiddenOutputRestorePendingChunks.length === 0
    ) {
      return false
    }
    if (!session.canUseHiddenOutputSnapshot(ptyId)) {
      return false
    }
    session.hiddenOutputRestorePtyId = ptyId
    if (session.hiddenOutputRestoreInFlight) {
      session.armHiddenOutputRestoreForegroundDeadline()
      return true
    }
    if (!opts?.bypassScheduler) {
      const priority = session.isActiveSplitPane() ? 'active' : 'inactive'
      if (priority === 'inactive') {
        if (!session.hiddenOutputRestoreScheduled) {
          session.hiddenOutputRestoreScheduled = true
          const scheduledPtyId = ptyId
          const scheduledGeneration = session.hiddenOutputRestoreGeneration
          // Why: resume can reveal many split panes at once; spread inactive replays across frames so xterm scrollback replay doesn't block return.
          scheduleHiddenOutputRestore(
            session.pane.terminal,
            () => {
              session.hiddenOutputRestoreScheduled = false
              if (
                session.disposed ||
                session.hiddenOutputRestoreGeneration !== scheduledGeneration ||
                session.hiddenOutputRestorePtyId !== scheduledPtyId ||
                session.transport.getPtyId() !== scheduledPtyId ||
                !session.canUseHiddenOutputSnapshot(scheduledPtyId) ||
                (!session.hiddenOutputRestoreNeeded &&
                  session.hiddenOutputRestorePendingChunks.length === 0) ||
                !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
              ) {
                return
              }
              session.requestHiddenOutputRestoreIfNeeded({ bypassScheduler: true })
            },
            priority
          )
        }
        return true
      }
      cancelScheduledHiddenOutputRestore(session.pane.terminal)
      session.hiddenOutputRestoreScheduled = false
    }
    session.clearHiddenOutputRestoreDeferredRetryTimer()
    session.hiddenOutputRestoreRetryDeferred = false

    session.hiddenOutputRestoreInFlight = (async () => {
      // Backstop (rc.7.perf loop): bound how many snapshot fetch+replay rounds one task burns before yielding to the live stream.
      let restoreIterations = 0
      while (!session.disposed) {
        const currentPtyId = session.hiddenOutputRestorePtyId
        if (currentPtyId === null) {
          session.clearHiddenOutputRestoreState()
          return
        }
        if (!session.canUseHiddenOutputSnapshot(currentPtyId)) {
          if (session.hiddenOutputRestorePtyId === currentPtyId) {
            session.clearHiddenOutputRestoreState()
          }
          // Remote-only path: the transport swapped PTYs mid-restore, which is a
          // stream change, not proof the hidden bytes are unrecoverable.
          if (
            !session.rearmRemoteHiddenOutputRestoreInsteadOfWarning(
              currentPtyId,
              'restore-pty-swapped'
            )
          ) {
            session.writeRestoreUnavailableWarning()
          }
          return
        }
        if (session.transport.getPtyId() !== currentPtyId) {
          if (session.hiddenOutputRestorePtyId === currentPtyId) {
            session.clearHiddenOutputRestoreState()
          }
          return
        }
        const restoreGeneration = session.hiddenOutputRestoreGeneration
        session.hiddenOutputRestoreNeeded = false
        let snapshotResult: HiddenOutputSnapshotResult
        try {
          snapshotResult = await session.serializeHiddenOutputSnapshot(currentPtyId, {
            scrollbackRows: resolveHiddenRestoreScrollbackRows(
              session.pane.terminal.options.scrollback
            )
          })
        } catch {
          snapshotResult =
            !isRemoteRuntimePtyId(currentPtyId) ||
            session.hiddenOutputRestoreLegacyPtyId === currentPtyId ||
            typeof session.transport.serializeBufferOutcome !== 'function'
              ? { kind: 'unavailable' }
              : // Why 'host': the only reject here is the request timeout — the frame went out and the host stayed silent.
                { kind: 'retry-worthy', source: 'host' }
        }
        if (session.disposed) {
          return
        }
        const restoreGenerationChanged = session.hiddenOutputRestoreGeneration !== restoreGeneration
        const restorePtyChanged =
          session.transport.getPtyId() !== currentPtyId ||
          session.hiddenOutputRestorePtyId !== currentPtyId
        if (restoreGenerationChanged || restorePtyChanged) {
          // Why: the snapshot belongs to the requested PTY; after reattach it's stale, and a stale generation may be an abandoned timeout superseded by a newer restore.
          if (restorePtyChanged && session.hiddenOutputRestorePtyId === currentPtyId) {
            session.clearHiddenOutputRestoreState()
          }
          return
        }
        if (snapshotResult.kind === 'retry-worthy') {
          let budgetExhausted: boolean
          if (snapshotResult.source === 'host') {
            session.hiddenOutputRestoreRemoteOutcomeAttempts += 1
            budgetExhausted =
              session.hiddenOutputRestoreRemoteOutcomeAttempts >=
              HIDDEN_OUTPUT_RESTORE_REMOTE_OUTCOME_MAX_ATTEMPTS
          } else {
            session.hiddenOutputRestoreLocalGateAttempts += 1
            budgetExhausted =
              session.hiddenOutputRestoreLocalGateAttempts >=
              HIDDEN_OUTPUT_RESTORE_LOCAL_GATE_MAX_ATTEMPTS
          }
          if (budgetExhausted) {
            session.abandonHiddenOutputRestoreAndDrainPendingForeground(currentPtyId, {
              rearmRemote: false
            })
            return
          }
          session.hiddenOutputRestoreNeeded = true
          session.hiddenOutputRestoreFreshSnapshotNeeded = false
          session.noteHiddenOutputRestoreFloodBackpressure()
          session.abandonHiddenOutputRestoreAndDrainPendingForeground(currentPtyId, { quiet: true })
          return
        }
        if (snapshotResult.kind === 'permanently-unavailable') {
          session.abandonHiddenOutputRestoreAndDrainPendingForeground(currentPtyId, {
            rearmRemote: false
          })
          return
        }
        if (snapshotResult.kind === 'unknown-legacy-host') {
          session.hiddenOutputRestoreLegacyPtyId = currentPtyId
          session.armHiddenOutputRestoreForegroundDeadline()
        }
        if (snapshotResult.kind !== 'snapshot') {
          session.hiddenOutputRestoreNeeded = true
          session.hiddenOutputRestoreFreshSnapshotNeeded = false
          session.hiddenOutputRestoreRetryDeferred = true
          session.scheduleHiddenOutputRestoreDeferredRetry()
          return
        }
        const snapshot = snapshotResult.snapshot
        session.hiddenOutputRestoreDeferredRetryAttempts = 0
        session.hiddenOutputRestoreRemoteAbandonCycles = 0
        session.hiddenOutputRestoreRemoteOutcomeAttempts = 0
        session.hiddenOutputRestoreLocalGateAttempts = 0
        restoreIterations += 1
        await session.applyMainBufferSnapshot(snapshot)
        if (
          session.disposed ||
          session.hiddenOutputRestoreGeneration !== restoreGeneration ||
          session.hiddenOutputRestorePtyId !== currentPtyId ||
          session.transport.getPtyId() !== currentPtyId
        ) {
          return
        }
        // Why: everything at/before snapshot.seq is now painted; chunks still draining from main's ACK backlog below it are duplicates to suppress.
        session.setRestoredSnapshotBaseline(
          currentPtyId,
          snapshot,
          restoredSnapshotPaintsPrintableContent(snapshot)
        )
        session.hiddenOutputRestoreReplayingSnapshot = null
        const needsFreshSnapshot = session.hiddenOutputRestoreFreshSnapshotNeeded
        session.hiddenOutputRestoreFreshSnapshotNeeded = false
        const drainOutcome = session.drainPendingLiveChunksAfterSnapshot(snapshot.seq)
        if (drainOutcome === 'drained' && !needsFreshSnapshot) {
          session.hiddenOutputRestoreNeeded = false
          session.hiddenOutputRestorePtyId = null
          session.clearHiddenOutputRestoreForegroundDeadlineTimer()
          return
        }
        if (!shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)) {
          // Why: hidden bytes arriving during the snapshot aren't in renderer memory; leave recovery pending for reveal, don't loop snapshots in a throttled tab.
          session.hiddenOutputRestoreNeeded = true
          return
        }
        if (drainOutcome === 'overflow') {
          // Cut 1 (rc.7.perf loop): a FOREGROUND queue overflow means the stream outruns fetch+replay; re-fetching starves ACKs, so abandon and heal with one post-flood repaint.
          session.noteHiddenOutputRestoreFloodBackpressure()
          session.abandonHiddenOutputRestoreAndDrainPendingForeground(currentPtyId, { quiet: true })
          return
        }
        if (restoreIterations >= HIDDEN_OUTPUT_RESTORE_MAX_LOOP_ITERATIONS) {
          // Backstop: re-looping this many times means the stream is winning the race.
          warnTerminalLifecycleAnomaly('hidden output restore hit its iteration cap', {
            tabId: session.deps.tabId,
            worktreeId: session.deps.worktreeId,
            leafId: session.pane.leafId,
            paneId: session.pane.id,
            ptyId: currentPtyId,
            reason: drainOutcome
          })
          session.noteHiddenOutputRestoreFloodBackpressure()
          session.abandonHiddenOutputRestoreAndDrainPendingForeground(currentPtyId, { quiet: true })
          return
        }
        session.hiddenOutputRestoreNeeded = true
      }
    })()
    const hiddenOutputRestoreTask = session.hiddenOutputRestoreInFlight
    let trackedHiddenOutputRestore: Promise<void>
    trackedHiddenOutputRestore = hiddenOutputRestoreTask.finally(() => {
      if (session.hiddenOutputRestoreInFlight === trackedHiddenOutputRestore) {
        session.hiddenOutputRestoreInFlight = null
      }
      // Why: after dispose the task body exits immediately, so re-arming here
      // resolves instantly and re-enters this handler — an unbounded promise
      // chain that eats the heap. The pane is gone; there is nothing to restore.
      if (session.disposed) {
        return
      }
      if (
        session.hiddenOutputRestorePendingChunks.length > 0 ||
        session.hiddenOutputRestorePendingOverflow
      ) {
        session.hiddenOutputRestoreNeeded = true
        session.armHiddenOutputRestoreForegroundDeadline()
      }
      if (
        !session.hiddenOutputRestoreRetryDeferred &&
        session.hiddenOutputRestoreNeeded &&
        shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
      ) {
        session.requestHiddenOutputRestoreIfNeeded()
      }
    })
    session.hiddenOutputRestoreInFlight = trackedHiddenOutputRestore
    return true
  }

  session.unregisterBacklogRecovery = registerTerminalBacklogRecovery(session.pane.terminal, () => {
    // Why: clear the hidden-delivery bit BEFORE the restore snapshot request; bytes arriving in between are reconciled by the seq guard.
    session.syncHiddenRendererPtyDelivery()
    return session.requestHiddenOutputRestoreIfNeeded()
  })
  if (
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function' &&
    typeof document.removeEventListener === 'function'
  ) {
    const onDocumentVisibilityChange = (): void => {
      // Why: document hide/show flips the foreground predicate with no pane lifecycle event; re-sync the hidden-delivery gate both ways.
      session.syncHiddenRendererPtyDelivery()
      if (shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)) {
        session.requestHiddenOutputRestoreIfNeeded()
      }
    }
    document.addEventListener('visibilitychange', onDocumentVisibilityChange)
    // Why: on stale macOS occlusion (visibilityState wedged 'hidden'), user input forces a resync — no visibilitychange fires, else the gate drops bytes forever.
    const unregisterStaleVisibilityRecovery = registerStaleDocumentVisibilityRecovery(
      onDocumentVisibilityChange
    )
    session.unregisterDocumentVisibilityRecovery = () => {
      document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
      unregisterStaleVisibilityRecovery()
    }
  }
}
