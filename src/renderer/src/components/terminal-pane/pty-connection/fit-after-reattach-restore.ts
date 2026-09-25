import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import type { ReattachPayloadContext } from './reattach-payload-context'
import type { ReattachPayloadSession } from './reattach-payload-session'

export async function fitAfterReattachRestore(
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
  if (!getFitOverrideForPty(reattachPtyId)) {
    const gridPush = session.createReattachGridPush(ctx.attemptGeneration, reattachPtyId)
    const fit = safeFitAndThen(session.pane, 'reattach-pty-resize', gridPush.continuation, {
      shouldContinue: gridPush.shouldContinue,
      retryIfUnmeasurable: true,
      // A restored hidden workspace still owes its PTY the applied grid when revealed.
      deferIfHidden: true
    })
    session.pendingReattachFit = fit
    try {
      // The continuation is shared by the immediate and deferred-until-revealed paths.
      await fit.completion
    } finally {
      if (session.pendingReattachFit === fit) {
        session.pendingReattachFit = null
      }
    }
  } else if (ctx.isCurrentReattachPayload() && !isRemoteRuntimePtyId(reattachPtyId)) {
    window.api.pty.signal(reattachPtyId, 'SIGWINCH')
  }
}
