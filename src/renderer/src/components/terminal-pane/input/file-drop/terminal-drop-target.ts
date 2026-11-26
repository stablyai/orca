import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'

export type CapturedTerminalDropTarget = {
  paneId: number
  leafId: string
  ptyId: string | null
  transport: PtyTransport
  blockWhileVeiled?: true
}

export function isTerminalPaneVeiled(container: HTMLElement): boolean {
  return container.querySelector('[data-remote-server-pane-veil]') !== null
}

export function captureTerminalDropTarget(
  pane: { id: number; leafId: string },
  transport: PtyTransport,
  options?: Pick<CapturedTerminalDropTarget, 'blockWhileVeiled'>
): CapturedTerminalDropTarget {
  return {
    paneId: pane.id,
    leafId: pane.leafId,
    ptyId: transport.getPtyId(),
    transport,
    ...options
  }
}

export function getCurrentTerminalDropTransport(
  manager: PaneManager,
  paneTransports: Map<number, PtyTransport>,
  target: CapturedTerminalDropTarget
): PtyTransport | null {
  const liveTransport = paneTransports.get(target.paneId)
  if (
    liveTransport !== target.transport ||
    !liveTransport.isConnected() ||
    liveTransport.getPtyId() !== target.ptyId
  ) {
    return null
  }
  const paneStillMounted = manager
    .getPanes()
    .some(
      (pane) =>
        pane.id === target.paneId &&
        pane.leafId === target.leafId &&
        (!target.blockWhileVeiled || !isTerminalPaneVeiled(pane.container))
    )
  return paneStillMounted ? liveTransport : null
}
