import type { CSSProperties } from 'react'
import type { TabDropZone } from './useTabDragSplit'
import { translate } from '@/i18n/i18n'

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

export default function TabGroupDropOverlay({
  zone,
  showPaneColumnLabel = false,
  fillContainer = false
}: {
  zone: TabDropZone
  showPaneColumnLabel?: boolean
  /** When the parent already sizes the overlay to the target region. */
  fillContainer?: boolean
}): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="tab-drop-overlay absolute"
      style={fillContainer ? { inset: 0 } : getOverlayStyle(zone)}
    >
      {showPaneColumnLabel && zone !== 'center' ? (
        <span className="tab-drop-overlay__label pointer-events-none absolute bottom-2 left-2 rounded-sm px-1.5 py-0.5 font-medium">
          {translate('auto.components.tab.group.TabGroupDropOverlay.paneColumnLabel', 'New split')}
        </span>
      ) : null}
    </div>
  )
}
