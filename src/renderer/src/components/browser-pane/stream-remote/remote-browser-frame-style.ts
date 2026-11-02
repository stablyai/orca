import type { CSSProperties } from 'react'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'
import { getPositiveFiniteNumber } from './remote-browser-page-input-model'

// Use the host’s displayed CSS viewport; bitmap dimensions vary with DPR and frame-budget scaling.
export function getRemoteBrowserFrameStyle(
  metadata: BrowserScreencastFrameMetadata | null
): CSSProperties {
  const width = getPositiveFiniteNumber(metadata?.deviceWidth)
  const height = getPositiveFiniteNumber(metadata?.deviceHeight)
  if (!width || !height) {
    return { width: '100%', height: '100%', objectFit: 'fill', objectPosition: 'top left' }
  }
  // Contain smaller or pre-resize frames without distortion; pointer mapping uses this same letterboxed box.
  const aspect = width / height
  return {
    inset: 0,
    margin: 'auto',
    width: `min(100cqw, calc(100cqh * ${aspect}))`,
    height: `min(100cqh, calc(100cqw / ${aspect}))`,
    objectFit: 'fill'
  }
}
