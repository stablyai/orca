import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { PtyTransport } from './pty-transport-types'

/** Local main replaces the named old PTY during spawn; remote hosts lack that field and retain kill-then-connect compatibility. */
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
