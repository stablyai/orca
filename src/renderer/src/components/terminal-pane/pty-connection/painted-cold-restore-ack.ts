import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import type { ReattachPayloadSession } from './reattach-payload-session'

/** The view painted `ptyId`'s cold restore; the terminal service may drop its copy. */
export function ackPaintedColdRestore(session: ReattachPayloadSession, ptyId: string): void {
  if (isRemoteRuntimePtyId(ptyId)) {
    return
  }
  // Switch point: main releases the copy only for the pane's current terminal.
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    window.api.pty.ackColdRestore(ptyId)
    return
  }
  window.api.pty.ackColdRestore(ptyId, {
    worktreeId: session.deps.worktreeId,
    tabId: session.deps.tabId,
    leafId: session.pane.leafId
  })
}
