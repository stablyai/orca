import type { PtyTransport } from './pty-transport-types'
import { isRemoteRuntimePtyId } from './pty-connection/paired-parked-terminal-restore'

/**
 * Releases a pane's transport for a restart and returns the PTY its replacement spawn must name.
 *
 * Why: main adopts a pane's live owner on spawn, so a local restart must not kill the old PTY
 * itself — the replacement spawn names it and main stops it before launching. Remote-runtime
 * hosts do not read that field, so they keep the kill-then-connect path.
 */
export function releasePaneTransportForRestart(transport: PtyTransport | undefined): string | null {
  const existingPtyId = transport?.getPtyId()
  const replacesPtyId =
    existingPtyId && transport?.detach && !isRemoteRuntimePtyId(existingPtyId)
      ? existingPtyId
      : null
  if (replacesPtyId) {
    transport?.detach?.({ preserveExitObserver: false })
  }
  transport?.destroy?.()
  return replacesPtyId
}
