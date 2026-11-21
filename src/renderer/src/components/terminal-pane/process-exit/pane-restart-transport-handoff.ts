import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { PtyTransport } from '../pty-transport/pty-transport-types'

/** Local main replaces the named old PTY during spawn; remote hosts lack that field and retain kill-then-connect compatibility. */
export function releasePaneTransportForRestart(
  transport: PtyTransport | undefined,
  conditionalAccount = false
): string | null {
  if (conditionalAccount) {
    if (transport && !transport.detach) {
      throw new Error('terminal_account_restart_unsupported')
    }
    transport?.detach?.({ preserveExitObserver: false })
    transport?.destroy?.()
    return null
  }
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
