import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'

import type { ReattachPayloadContext } from './reattach-payload-context'
import type { ReattachPayloadSession } from './reattach-payload-session'

/** Records a too-wide alt frame the reattach replay omitted, keyed by its capture width. */
export function noteReattachAltFrameSkip(
  ctx: ReattachPayloadContext,
  skip: boolean,
  captureCols: number | undefined
): boolean {
  if (skip) {
    ctx.skippedAltFrameCaptureCols = captureCols ?? null
  }
  return skip
}

/** Fits a reattached pane and pushes the resulting grid to its PTY. */
export async function fitReattachedPaneToGrid(
  session: ReattachPayloadSession,
  ctx: ReattachPayloadContext
): Promise<void> {
  if (!ctx.isCurrentReattachPayload()) {
    return
  }
  const reattachPtyId = session.transport.getPtyId()
  if (!reattachPtyId) {
    return
  }
  if (getFitOverrideForPty(reattachPtyId)) {
    if (ctx.isCurrentReattachPayload() && !isRemoteRuntimePtyId(reattachPtyId)) {
      window.api.pty.signal(reattachPtyId, 'SIGWINCH')
    }
    return
  }
  const gridPush = session.createReattachGridPush(ctx.attemptGeneration, reattachPtyId)
  const continuation = (): void => {
    gridPush.continuation()
    // Why: a fit that lands back on the capture grid sends only a same-size SIGWINCH, which apps like OpenTUI ignore; the model still holds the omitted frame.
    if (
      gridPush.shouldContinue() &&
      ctx.skippedAltFrameCaptureCols === session.pane.terminal.cols
    ) {
      session.markHiddenOutputRestoreNeeded()
    }
  }
  const fit = safeFitAndThen(session.pane, 'reattach-pty-resize', continuation, {
    shouldContinue: gridPush.shouldContinue,
    retryIfUnmeasurable: true,
    // Hidden floating panels must defer grid push through reveal or leave the PTY pinned at replay geometry.
    deferIfHidden: true
  })
  session.pendingReattachFit = fit
  try {
    // Verify applied size in the continuation reached by both immediate and reveal-deferred fits.
    await fit.completion
  } finally {
    if (session.pendingReattachFit === fit) {
      session.pendingReattachFit = null
    }
  }
}
