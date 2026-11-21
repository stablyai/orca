import { IMAGE_VIEWER_ZOOM_STEP } from '@/components/editor/viewer-viewport/image-viewer-zoom'
import type { PanZoomViewport } from '@/components/editor/viewer-viewport/use-pan-zoom-viewport'
import type { NativeChatNoteMark } from './native-chat-media-notes'

const PAN_STEP_PX = 60
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
}

/** Keys on the focused media viewport: arrows pan a zoomed image, + − 0 zoom and fit, and Enter pins
 *  the middle of what is in view while annotating. True when the key was used. */
export function handleNativeChatMediaViewportKey(
  event: React.KeyboardEvent<HTMLDivElement>,
  {
    panZoom,
    annotating,
    onPlace
  }: {
    panZoom: Pick<PanZoomViewport, 'zoomBy' | 'fit' | 'isFitted' | 'canZoomIn' | 'canZoomOut'>
    annotating: boolean
    onPlace: (mark: NativeChatNoteMark) => void
  }
): boolean {
  // Keys on a mark (move it) or inside the panel are theirs.
  if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey) {
    return false
  }
  const arrow = ARROWS[event.key]
  if (arrow && !panZoom.isFitted) {
    // The viewport's own wheel handling pans and keeps the image in bounds.
    event.currentTarget.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: arrow[0] * PAN_STEP_PX,
        deltaY: arrow[1] * PAN_STEP_PX,
        cancelable: true
      })
    )
    return true
  }
  if ((event.key === '+' || event.key === '=') && panZoom.canZoomIn) {
    panZoom.zoomBy(IMAGE_VIEWER_ZOOM_STEP)
    return true
  }
  if (event.key === '-' && panZoom.canZoomOut) {
    panZoom.zoomBy(1 / IMAGE_VIEWER_ZOOM_STEP)
    return true
  }
  if (event.key === '0') {
    panZoom.fit()
    return true
  }
  if (event.key === 'Enter' && annotating) {
    onPlace({ kind: 'pin', ...nativeChatVisibleMediaCenter(event.currentTarget) })
    return true
  }
  return false
}

/** The middle of the viewport in media coordinates (0–1), clamped to the media. */
function nativeChatVisibleMediaCenter(viewport: HTMLElement): { x: number; y: number } {
  const layer = viewport.querySelector('[data-native-chat-note-layer]')?.getBoundingClientRect()
  const view = viewport.getBoundingClientRect()
  if (!layer || layer.width === 0 || layer.height === 0) {
    return { x: 0.5, y: 0.5 }
  }
  const clamp = (value: number): number => Math.min(1, Math.max(0, value))
  return {
    x: clamp((view.left + view.width / 2 - layer.left) / layer.width),
    y: clamp((view.top + view.height / 2 - layer.top) / layer.height)
  }
}

/** Focuses the viewport on the next frame, unless focus moved meanwhile: a key pressed right after C
 *  (Enter opening a note) already put it where the user is typing. */
export function focusNativeChatMediaViewportSoon(viewport: HTMLElement | null): void {
  const from = document.activeElement
  requestAnimationFrame(() => {
    if (document.activeElement === from) {
      viewport?.focus({ preventScroll: true })
    }
  })
}
