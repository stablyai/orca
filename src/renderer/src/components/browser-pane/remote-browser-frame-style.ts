import type { CSSProperties } from 'react'
import type { BrowserScreencastFrameMetadata } from '../../../../shared/browser-screencast-protocol'

export function getRemoteBrowserFrameStyle(
  _metadata: BrowserScreencastFrameMetadata | null
): CSSProperties {
  // Why: the runtime now rejects server-sized frames when a client viewport was
  // requested. The renderer should display that authoritative viewport exactly,
  // not infer crop/contain behavior from transient bitmap dimensions.
  return {
    width: '100%',
    height: '100%',
    objectFit: 'fill',
    objectPosition: 'top left'
  }
}
