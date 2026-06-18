import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'

export type CapturedTerminalDropTarget = {
  paneId: number
  leafId: string
  ptyId: string | null
  transport: PtyTransport
}

export function captureTerminalDropTarget(
  pane: { id: number; leafId: string },
  transport: PtyTransport
): CapturedTerminalDropTarget {
  return {
    paneId: pane.id,
    leafId: pane.leafId,
    ptyId: transport.getPtyId(),
    transport
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
  const activePane = manager.getActivePane()
  const paneStillMounted =
    manager.getPanes().some((pane) => pane.id === target.paneId && pane.leafId === target.leafId) ||
    (activePane?.id === target.paneId && activePane.leafId === target.leafId)
  return paneStillMounted ? liveTransport : null
}
