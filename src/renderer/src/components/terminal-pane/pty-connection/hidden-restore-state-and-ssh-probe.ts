import { useAppStore } from '@/store'
import type { PtyBufferSnapshot } from '../pty-transport'
import { INITIAL_MODE_2031_REPLY_SCAN_STATE } from '../../../../../shared/terminal-color-scheme-protocol'
import { discardTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { cancelTerminalScrollIntentBufferRebuildCompletions } from '@/lib/pane-manager/terminal-scroll-intent-rebuild'
import { DeferredReattachLiveDataQueue } from '../deferred-reattach-live-data-queue'
import { resolveHiddenRestoreScrollbackRows } from '../terminal-hidden-restore-scrollback'
import {
  decideSshReattachPaintSource,
  memoizeSshReattachModelSnapshotProbe,
  resolveSshReattachModelSnapshotWithTimeout,
  shouldFetchSshReattachModelSnapshot
} from '../ssh-reattach-model-restore'

import {
  HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MS,
  HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MAX
} from './hidden-output-restore-limits'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { recordHiddenRendererSkip } from './e2e-terminal-pty-harness'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindHiddenOutputRestoreSnapshot } from './hidden-output-restore-snapshot'
import { bindHiddenOutputRestoreRequest } from './hidden-output-restore-request'
import { bindLiveDataCallback } from './live-data-callback'

import { bindReattachLiveDataDeferral } from './reattach-live-data-deferral'

export function bindHiddenRestoreStateAndSshProbe(session: ConnectPanePtySession): void {
  session.scheduleHiddenOutputRestoreDeferredRetry = function (): void {
    if (
      session.disposed ||
      session.hiddenOutputRestoreDeferredRetryTimer !== null ||
      !shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
    ) {
      return
    }
    if (
      session.hiddenOutputRestoreDeferredRetryAttempts >= HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MAX
    ) {
      const ptyId = session.hiddenOutputRestorePtyId
      if (ptyId !== null) {
        session.abandonHiddenOutputRestoreAndDrainPendingForeground(ptyId)
      } else {
        session.clearHiddenOutputRestoreState()
        session.writeRestoreUnavailableWarning()
      }
      return
    }
    session.hiddenOutputRestoreDeferredRetryAttempts += 1
    // Why: a null snapshot usually means remote output was still mutating; retry after one quiet tick instead of spinning.
    session.hiddenOutputRestoreDeferredRetryTimer = setTimeout(() => {
      session.hiddenOutputRestoreDeferredRetryTimer = null
      if (session.disposed || !session.hiddenOutputRestoreNeeded) {
        return
      }
      session.hiddenOutputRestoreRetryDeferred = false
      session.requestHiddenOutputRestoreIfNeeded()
    }, HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MS)
  }

  session.clearHiddenOutputRestoreState = function (): void {
    session.cancelSnapshotScrollRestore()
    session.clearPendingLiveChunksDuringRestore()
    // Re-arm budget is per PTY stream, like the rest of this state.
    session.hiddenOutputRestoreRemoteAbandonCycles = 0
    session.hiddenOutputRestoreRemoteOutcomeAttempts = 0
    session.hiddenOutputRestoreLocalGateAttempts = 0
    session.hiddenStartupRendererQueryPending = ''
    session.hiddenRendererStateDirty = false
    session.hiddenOutputRestoreNeeded = false
    session.hiddenOutputRestorePtyId = null
    session.hiddenOutputRestoreReplayingSnapshot = null
    session.hiddenOutputRestoreGeneration += 1
  }

  session.cancelSnapshotScrollRestore = function (): void {
    session.pendingHiddenSnapshotFit?.cancel()
    session.pendingHiddenSnapshotFit = null
    const scrollRestore = session.hiddenOutputSnapshotScrollRestore
    if (!scrollRestore) {
      return
    }
    scrollRestore.valid = false
    session.hiddenOutputSnapshotScrollRestore = null
    if (scrollRestore.started) {
      cancelTerminalScrollIntentBufferRebuildCompletions(session.pane.terminal)
    }
    // Why: invalidation suppresses restoration, but queued bytes still own the bracket until their FIFO sentinels prove parsing finished.
  }
  session.cancelHiddenOutputSnapshotScrollRestore = session.cancelSnapshotScrollRestore

  session.clearPaneMode2031State = function (): void {
    session.deps.paneMode2031Ref.current.delete(session.pane.id)
    session.deps.paneLastThemeModeRef.current.delete(session.pane.id)
    // A partial CSI prefix belongs to the stream that produced it; carrying it into a
    // replacement PTY would splice two unrelated byte ranges into one sequence.
    session.mode2031ReplyScanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
  }

  session.pulseVisibleLocalPtySizeForTuiRepaint = function (ptyId: string): void {
    if (
      !session.isRendererPtyResizeAuthoritative() ||
      session.shouldSuppressDesktopPtyResize() ||
      isRemoteRuntimePtyId(ptyId)
    ) {
      return
    }
    const cols = session.pane.terminal.cols
    const rows = session.pane.terminal.rows
    if (cols <= 2 || rows <= 0) {
      return
    }
    // Why: a hidden alt-screen TUI can miss the same-size restore SIGWINCH; a one-column pulse makes the repaint observable to the child.
    session.transport.resize(cols - 1, rows)
    session.transport.resize(cols, rows)
  }

  session.skipBackgroundAlternateScreenOutput = function (data: string): void {
    session.writeHiddenStartupRendererQueries(data)
    session.hiddenRendererStateDirty = true
    recordHiddenRendererSkip(data.length)
    const ptyId = session.transport.getPtyId()
    if (!ptyId || session.alternateScreenBackgroundRepaintTimer !== null) {
      return
    }
    session.pulseVisibleLocalPtySizeForTuiRepaint(ptyId)
    session.alternateScreenBackgroundRepaintTimer = setTimeout(() => {
      session.alternateScreenBackgroundRepaintTimer = null
    }, 100)
  }

  session.resetHiddenOutputRestoreIfPtyChanged = function (): void {
    if (session.hiddenOutputRestorePtyId === null) {
      return
    }
    if (session.transport.getPtyId() !== session.hiddenOutputRestorePtyId) {
      // Why: renderer backlog is tied to the old PTY stream; after reattach it must not delay or replay before the new PTY.
      session.clearHiddenOutputRestoreState()
      session.clearRestoredSnapshotBaseline()
      session.clearPaneMode2031State()
      // Why: flood-backpressure evidence is per PTY stream too.
      session.resetHiddenOutputRestoreFloodSuppression()
      discardTerminalOutput(session.pane.terminal)
    }
  }

  bindHiddenOutputRestoreSnapshot(session)
  bindHiddenOutputRestoreRequest(session)
  bindLiveDataCallback(session)
  session.beginReattachLiveDataDeferral = (
    ownerGeneration = session.transportStreamGeneration
  ): void => {
    session.reattachLiveDataDeferralDepth += 1
    if (session.reattachLiveDataDeferralDepth === 1) {
      session.deferredReattachLiveData = new DeferredReattachLiveDataQueue()
      session.deferredReattachLiveDataOwners = new Map()
    }
    if (!session.deferredReattachLiveDataOwners.has(ownerGeneration)) {
      session.deferredReattachLiveDataOwners.set(ownerGeneration, { failed: false })
    }
  }

  session.beginReattachLiveDataDeferralIfUnowned = (
    ownerGeneration = session.transportStreamGeneration
  ): void => {
    if (!session.deferredReattachLiveDataOwners.has(ownerGeneration)) {
      session.beginReattachLiveDataDeferral(ownerGeneration)
    }
  }

  bindReattachLiveDataDeferral(session)
  session.isCapturedDirectSshReattachCurrent = (ptyId: string): boolean =>
    !session.directSshRetryAttempt || session.capturedDirectSshRetryStateMatches(ptyId)
  session.rejectObsoleteDirectSshReattach = (ptyId: string | null | undefined): boolean => {
    if (
      !session.directSshRetryAttempt ||
      (ptyId && session.claimCapturedDirectSshRetryPty(ptyId))
    ) {
      return false
    }
    session.transport.detach?.({ preserveExitObserver: false })
    return true
  }

  let parkedSshSnapshotPrefetch: {
    ptyId: string
    fetch: () => Promise<PtyBufferSnapshot | null>
  } | null = null

  const createSshMainModelSnapshotProbe = (
    ptyId: string
  ): (() => Promise<PtyBufferSnapshot | null>) =>
    memoizeSshReattachModelSnapshotProbe(async (): Promise<PtyBufferSnapshot | null> => {
      const sshParkingEnabled = useAppStore.getState().settings?.terminalSshViewParking !== false
      if (!shouldFetchSshReattachModelSnapshot({ ptyId, sshParkingEnabled })) {
        return null
      }
      const snapshot = await resolveSshReattachModelSnapshotWithTimeout(
        window.api.pty.getMainBufferSnapshot(ptyId, {
          scrollbackRows: resolveHiddenRestoreScrollbackRows(
            session.pane.terminal.options.scrollback
          )
        })
      )
      return snapshot &&
        decideSshReattachPaintSource({ ptyId, sshParkingEnabled, snapshot }) ===
          'main-model-snapshot'
        ? snapshot
        : null
    })

  session.getSshMainModelSnapshotProbe = (
    ptyId: string
  ): (() => Promise<PtyBufferSnapshot | null>) => {
    if (parkedSshSnapshotPrefetch?.ptyId !== ptyId) {
      parkedSshSnapshotPrefetch = { ptyId, fetch: createSshMainModelSnapshotProbe(ptyId) }
    }
    return parkedSshSnapshotPrefetch.fetch
  }
}
