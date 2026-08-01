import type { RemoteTerminalTarget } from '@/components/peer-collab/remote-terminal-target'
import { resolveDockZone, type PeersDockZone } from './peers-dock-zone'
import { leafKey } from './peers-split-tree'

type ClientRectLike = { left: number; top: number; width: number; height: number }

/** Shape of the fields PeersPanels reads off a dnd-kit DragMoveEvent/DragEndEvent — kept
 *  as plain data so drop resolution is testable without simulating a real drag. */
export type PeersDockDropEvent = {
  activeData: { type?: string; tab?: RemoteTerminalTarget } | undefined
  /** `active.rect.current.translated` — null before dnd-kit has measured the drag. */
  activeTranslatedRect: ClientRectLike | null
  overData: { type?: string; leafKey?: string } | undefined
  overRect: ClientRectLike | undefined
}

export type PeersDockDropAction = {
  atLeafKey: string
  side: PeersDockZone
  newTarget: RemoteTerminalTarget
}

/** Resolves a peers-tab drag ending over a dock pane into the splitPeersPane call to make, or null when the drop isn't a valid dock (wrong payload, no geometry, outside every edge band, or dropped on its own pane). */
export function resolvePeersDockDrop(event: PeersDockDropEvent): PeersDockDropAction | null {
  if (event.activeData?.type !== 'peers-tab' || !event.activeData.tab) {
    return null
  }
  if (event.overData?.type !== 'peers-dock-pane' || !event.overData.leafKey) {
    return null
  }
  if (!event.activeTranslatedRect || !event.overRect) {
    return null
  }
  const activeCenter = {
    x: event.activeTranslatedRect.left + event.activeTranslatedRect.width / 2,
    y: event.activeTranslatedRect.top + event.activeTranslatedRect.height / 2
  }
  const overPaneRect = {
    x: event.overRect.left,
    y: event.overRect.top,
    width: event.overRect.width,
    height: event.overRect.height
  }
  const draggedLeafKey = leafKey(event.activeData.tab)
  const zone = resolveDockZone(activeCenter, overPaneRect, {
    draggedLeafKey,
    paneLeafKey: event.overData.leafKey
  })
  if (!zone) {
    return null
  }
  return { atLeafKey: event.overData.leafKey, side: zone, newTarget: event.activeData.tab }
}
