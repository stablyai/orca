import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { PtyTransport } from './pty-transport-types'

export function reportActiveRendererPtyForPane(
  paneTransports: Map<number, PtyTransport>,
  activePaneId: number | null
): void {
  for (const [paneId, transport] of paneTransports) {
    const ptyId = transport.getPtyId()
    if (!ptyId || isRemoteRuntimePtyId(ptyId)) {
      continue
    }
    window.api.pty.setActiveRendererPty?.(ptyId, activePaneId === paneId)
  }
}
