import type { CSSProperties } from 'react'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'
import { getPositiveFiniteNumber } from './remote-browser-page-input-model'

// Why the device size and not the bitmap's: the host labels every frame with the CSS viewport it
// shows, while the bitmap's own size moves with DPR and the frame budget's scaling.
export function getRemoteBrowserFrameStyle(
  metadata: BrowserScreencastFrameMetadata | null
): CSSProperties {
  const width = getPositiveFiniteNumber(metadata?.deviceWidth)
  const height = getPositiveFiniteNumber(metadata?.deviceHeight)
  if (!width || !height) {
    return { width: '100%', height: '100%', objectFit: 'fill', objectPosition: 'top left' }
  }
  // Why contain: a host can stream a smaller viewport than this pane asked for (it cannot paint
  // past its own view), and a frame from before a resize lands in a pane of another shape.
  // Stretching either distorts the page. Pointer input reads this box back off the image.
  const aspect = width / height
  return {
    inset: 0,
    margin: 'auto',
    width: `min(100cqw, calc(100cqh * ${aspect}))`,
    height: `min(100cqh, calc(100cqw / ${aspect}))`,
    objectFit: 'fill'
  }
}
