import type { CSSProperties } from 'react'
import type { TabDropZone } from './useTabDragSplit'

function getOverlayStyle(zone: TabDropZone): CSSProperties {
  switch (zone) {
    case 'up':
      return { top: 0, left: 0, width: '100%', height: '50%' }
    case 'down':
      return { top: '50%', left: 0, width: '100%', height: '50%' }
    case 'left':
      return { top: 0, left: 0, width: '50%', height: '100%' }
    case 'right':
      return { top: 0, left: '50%', width: '50%', height: '100%' }
    case 'center':
      return { inset: 0 }
  }
}

export default function TabGroupDropOverlay({ zone }: { zone: TabDropZone }): React.JSX.Element {
  return (
    <div aria-hidden="true" className="tab-drop-overlay absolute" style={getOverlayStyle(zone)} />
  )
}
