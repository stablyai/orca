import { useAppStore } from '@/store/index'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { PtyConnectResult } from '../../pty-transport/pty-transport-types'
import { findTerminalTabForPane } from '../terminal-tab-id'
import { acceptRetainedTerminalHistory } from './retained-terminal-history'

/** An unsuccessful replacement proves nothing about its predecessor; only an exact live attach releases input. */
export async function reattachRestartPredecessor(
  session: ConnectPanePtySession
): Promise<string | null> {
  const owner = session.deps.restartRecovery
  if (!owner?.ptyId || !owner.incarnationId) {
    return null
  }
  const { ptyId, incarnationId } = owner
  const current = (): boolean => {
    const state = useAppStore.getState()
    const tab = findTerminalTabForPane(state, session.deps.worktreeId, session.deps.tabId)
    return (
      !session.disposed &&
      session.deps.restartRecovery === owner &&
      session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
      tab !== null &&
      (tab.generation ?? 0) === session.tabGeneration &&
      state.terminalLayoutsByTabId[session.deps.tabId]?.ptyIdsByLeafId?.[session.pane.leafId] ===
        ptyId
    )
  }
  if (!current()) {
    return null
  }
  // A failed Restart's startup belongs to its refused replacement, never the live predecessor.
  session.pendingStartupCommand = null
  session.paneStartup = null
  const output = session.captureTransportOutputCallbacks(() => {}, null, null)
  const isCurrent = (): boolean =>
    current() && output.generation === session.transportStreamGeneration
  session.beginReattachLiveDataDeferral(output.generation)
  const serializer = window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)
  let accepted = false
  try {
    const result = await session.transport.connect({
      url: '',
      cols: session.cols,
      rows: session.rows,
      sessionId: ptyId,
      attachOnlyView: true,
      expectedAttachIncarnationId: incarnationId,
      shouldContinue: isCurrent,
      callbacks: output.callbacks
    })
    if (
      !isCurrent() ||
      !result ||
      typeof result !== 'object' ||
      result.id !== ptyId ||
      result.incarnationId !== incarnationId ||
      !result.isReattach ||
      result.sessionExpired ||
      result.exitedBeforeAttach ||
      result.coldRestore
    ) {
      return null
    }
    const attached: PtyConnectResult = result
    accepted =
      attached.snapshot || attached.replay
        ? await session.handleReattachResult(
            attached,
            ptyId,
            null,
            output.generation,
            output.launchContext,
            isCurrent
          )
        : session.bindActivePanePty(ptyId, {
            updateTabPtyId: 'if-missing',
            sampleVisibleForegroundAgent: true
          })
    if (!accepted || !isCurrent()) {
      accepted = false
      return null
    }
    session.remotePtyIncarnationId = incarnationId
    session.noteBoundProcessIncarnation(incarnationId)
    acceptRetainedTerminalHistory(session, false)
    session.deps.consumeSuppressedPtyExit(ptyId)
    if (!attached.snapshot && !attached.replay) {
      session.registerPaneSerializerFor(ptyId)
    }
    session.deps.restartRecovery = undefined
    session.settlePaneAttachAttempt?.('success')
    return ptyId
  } catch {
    // Missing/changed/uncertain owners keep their read-only image; this path never starts or retires a PTY.
    return null
  } finally {
    session.finishReattachLiveDataDeferral(accepted, output.generation)
    void serializer
      .then((generation) => {
        if (typeof generation !== 'number') {
          return
        }
        return accepted && !session.disposed
          ? window.api.pty.settlePaneSerializer(session.cacheKey, generation)
          : window.api.pty.clearPendingPaneSerializer(session.cacheKey, generation)
      })
      .catch(() => {})
  }
}
