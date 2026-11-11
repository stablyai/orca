import type { IDisposable } from '@xterm/xterm'
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

/** Remote panes have no main-side active claim; each retunes its host output cadence instead. */
export function syncPaneOutputCadences(panePtyBindings: Map<number, IDisposable>): void {
  for (const binding of panePtyBindings.values()) {
    const cadenceBinding: IDisposable & { syncOutputCadence?: () => void } = binding
    cadenceBinding.syncOutputCadence?.()
  }
}
