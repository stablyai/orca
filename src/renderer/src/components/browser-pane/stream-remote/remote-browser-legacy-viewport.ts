import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'
import {
  areRemoteViewportSizesNear,
  type RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'

const MIN_VIEWPORT_WIDTH = 320
const MIN_VIEWPORT_HEIGHT = 240
const MAX_ASPECT_DRIFT = 0.05

function positiveNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function getLegacyRemoteBrowserViewport(
  metadata: BrowserScreencastFrameMetadata,
  requested: RemoteBrowserViewportSize
): RemoteBrowserViewportSize | null {
  const imageWidth = positiveNumber(metadata.imageWidth)
  const imageHeight = positiveNumber(metadata.imageHeight)
  if (!imageWidth || !imageHeight || requested.width <= 0 || requested.height <= 0) {
    return null
  }

  const requestedAspect = requested.width / requested.height
  const imageAspect = imageWidth / imageHeight
  if (Math.abs(imageAspect / requestedAspect - 1) <= MAX_ASPECT_DRIFT) {
    return null
  }

  const uniformScale = Math.max(1, imageWidth / requested.width, imageHeight / requested.height)
  const captureWidth = imageWidth / uniformScale
  const captureHeight = imageHeight / uniformScale
  const width = Math.round(captureWidth)
  const height = Math.round(Math.min(requested.height, captureHeight))
  if (width < MIN_VIEWPORT_WIDTH || height < MIN_VIEWPORT_HEIGHT) {
    return null
  }
  return { width, height }
}

export class RemoteBrowserLegacyViewport {
  private viewport: RemoteBrowserViewportSize | null = null
  private source: RemoteBrowserViewportSize | null = null

  clear(): void {
    this.viewport = null
    this.source = null
  }

  recover(
    metadata: BrowserScreencastFrameMetadata,
    requested: RemoteBrowserViewportSize | null
  ): boolean {
    if (this.viewport || !requested) {
      return false
    }
    const viewport = getLegacyRemoteBrowserViewport(metadata, requested)
    if (!viewport) {
      return false
    }
    this.viewport = viewport
    this.source = requested
    return true
  }

  resolve(measured: RemoteBrowserViewportSize | null): RemoteBrowserViewportSize | null {
    if (measured && this.source && !areRemoteViewportSizesNear(this.source, measured)) {
      this.clear()
    }
    return this.viewport ?? measured
  }
}

export function getLegacyViewportForRendering(
  resolved: RemoteBrowserViewportSize | null,
  measured: RemoteBrowserViewportSize | null
): RemoteBrowserViewportSize | null {
  if (!resolved || !measured || areRemoteViewportSizesNear(resolved, measured)) {
    return null
  }
  return resolved
}
