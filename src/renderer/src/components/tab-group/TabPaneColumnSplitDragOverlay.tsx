import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import TabGroupDropOverlay from './TabGroupDropOverlay'
import type { TabDropZone } from './useTabDragSplit'

function getOverlayBounds(
  rect: DOMRect,
  zone: Exclude<TabDropZone, 'center'>
): Pick<CSSProperties, 'top' | 'left' | 'width' | 'height'> {
  switch (zone) {
    case 'up':
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height / 2
      }
    case 'down':
      return {
        top: rect.top + rect.height / 2,
        left: rect.left,
        width: rect.width,
        height: rect.height / 2
      }
    case 'left':
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width / 2,
        height: rect.height
      }
    case 'right':
      return {
        top: rect.top,
        left: rect.left + rect.width / 2,
        width: rect.width / 2,
        height: rect.height
      }
  }
}

export default function TabPaneColumnSplitDragOverlay({
  panelRect,
  zone
}: {
  panelRect: DOMRect
  zone: Exclude<TabDropZone, 'center'>
}): React.JSX.Element | null {
  const bounds = getOverlayBounds(panelRect, zone)
  return createPortal(
    <div aria-hidden="true" className="pointer-events-none fixed z-[10001]" style={bounds}>
      <TabGroupDropOverlay zone={zone} showPaneColumnLabel fillContainer />
    </div>,
    document.body
  )
}
