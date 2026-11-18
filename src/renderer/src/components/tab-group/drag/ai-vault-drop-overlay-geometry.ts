import type { CSSProperties } from 'react'
import type { TabDropZone } from './tab-drag-data'
export function getZoneOverlayStyle(
  rect: DOMRect,
  layerRect: DOMRect,
  zone: TabDropZone
): CSSProperties {
  const left = rect.left - layerRect.left
  const top = rect.top - layerRect.top
  const width = rect.width
  const height = rect.height

  switch (zone) {
    case 'up':
      return { left, top, width, height: height / 2 }
    case 'down':
      return { left, top: top + height / 2, width, height: height / 2 }
    case 'left':
      return { left, top, width: width / 2, height }
    case 'right':
      return { left: left + width / 2, top, width: width / 2, height }
    case 'center':
      return { left, top, width, height }
  }
}
