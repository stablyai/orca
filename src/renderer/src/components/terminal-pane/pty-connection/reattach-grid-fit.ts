import { safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'

import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
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
    // Why only this caller: a restored floating workspace is display:none until the
    // user opens it, so dropping the grid push strands the PTY at the replay grid.
    deferIfHidden: true
  })
  session.pendingReattachFit = fit
  try {
    // Why: reattach resize is fire-and-forget, so the continuation itself requests the
    // applied-grid verification — it is the only point reached by both the immediate
    // and the deferred-until-revealed path.
    await fit.completion
  } finally {
    if (session.pendingReattachFit === fit) {
      session.pendingReattachFit = null
    }
  }
}
