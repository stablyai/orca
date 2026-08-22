import type { CSSProperties } from 'react'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'

type Size = { width: number; height: number }

function positiveNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function shouldContainRemoteBrowserFrame(
  metadata: BrowserScreencastFrameMetadata | null
): boolean {
  const imageWidth = positiveNumber(metadata?.imageWidth)
  const imageHeight = positiveNumber(metadata?.imageHeight)
  const deviceWidth = positiveNumber(metadata?.deviceWidth)
  const deviceHeight = positiveNumber(metadata?.deviceHeight)
  if (!imageWidth || !imageHeight || !deviceWidth || !deviceHeight) {
    return false
  }
  const relativeScale = imageWidth / deviceWidth / (imageHeight / deviceHeight)
  return relativeScale < 0.95 || relativeScale > 1.05
}

export function getRemoteBrowserFrameStyle(
  metadata: BrowserScreencastFrameMetadata | null,
  legacyViewport: Size | null = null
): CSSProperties {
  if (legacyViewport) {
    return {
      width: `${legacyViewport.width}px`,
      height: `${legacyViewport.height}px`,
      left: '50%',
      transform: 'translateX(-50%)',
      objectFit: 'fill',
      objectPosition: 'top left'
    }
  }
  return {
    width: '100%',
    height: '100%',
    // Why: legacy headed hosts can capture their narrower BrowserView while claiming the client viewport.
    objectFit: shouldContainRemoteBrowserFrame(metadata) ? 'contain' : 'fill',
    objectPosition: 'top left'
  }
}
