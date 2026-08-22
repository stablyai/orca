import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'
import { shouldContainRemoteBrowserFrame } from './remote-browser-frame-style'

type Size = { width: number; height: number }
type Rect = Size & { left: number; top: number }

type RemoteBrowserFramePointInput = {
  clientX: number
  clientY: number
  viewportRect: Rect
  naturalWidth: number
  naturalHeight: number
  metadata: BrowserScreencastFrameMetadata | null
  remoteCssViewportSize: Size | null
  remoteViewportSize: Size | null
  legacyViewportSize?: Size | null
}

function positiveNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function getRemoteBrowserFramePoint(
  input: RemoteBrowserFramePointInput
): { x: number; y: number } | null {
  const { viewportRect: rect } = input
  if (rect.width <= 0 || rect.height <= 0 || input.naturalWidth <= 0 || input.naturalHeight <= 0) {
    return null
  }

  if (input.legacyViewportSize) {
    const width = input.legacyViewportSize.width
    const height = input.legacyViewportSize.height
    const left = Math.max(0, (rect.width - width) / 2)
    const x = input.clientX - rect.left - left
    const y = input.clientY - rect.top
    if (x < 0 || y < 0 || x > width || y > height) {
      return null
    }
    return { x: Math.round(x), y: Math.round(y) }
  }

  if (shouldContainRemoteBrowserFrame(input.metadata)) {
    const scale = Math.min(rect.width / input.naturalWidth, rect.height / input.naturalHeight)
    const width = input.naturalWidth * scale
    const height = input.naturalHeight * scale
    const x = input.clientX - rect.left
    const y = input.clientY - rect.top
    if (x < 0 || y < 0 || x > width || y > height) {
      return null
    }
    return {
      x: Math.round((x / width) * input.naturalWidth),
      y: Math.round((y / height) * input.naturalHeight)
    }
  }

  const viewportWidth =
    positiveNumber(input.remoteCssViewportSize?.width) ??
    positiveNumber(input.remoteViewportSize?.width) ??
    positiveNumber(input.metadata?.deviceWidth) ??
    input.naturalWidth
  const viewportHeight =
    positiveNumber(input.remoteCssViewportSize?.height) ??
    positiveNumber(input.remoteViewportSize?.height) ??
    positiveNumber(input.metadata?.deviceHeight) ??
    input.naturalHeight
  return {
    x: Math.round(((input.clientX - rect.left) / rect.width) * viewportWidth),
    y: Math.round(((input.clientY - rect.top) / rect.height) * viewportHeight)
  }
}
