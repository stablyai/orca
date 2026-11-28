/** Reference-count passthrough for overlapping renderer drags across local guests and retained hosts; registration/show owns applying it to newly hittable surfaces. */

export type WebviewDragPassthroughSurface = (passthrough: boolean) => void

const passthroughTokens = new Set<symbol>()
// Subset of passthroughTokens held for native HTML5 drags (file paths, text) rather than pointer gestures.
const nativeDragTokens = new Set<symbol>()
const passthroughSurfaces = new Set<WebviewDragPassthroughSurface>()

export function isWebviewDragPassthroughActive(): boolean {
  return passthroughTokens.size > 0
}

/** Pointer gestures only (tab drag, resize, docks); native drags still reach guests that accept drops. */
export function isWebviewPointerDragPassthroughActive(): boolean {
  return passthroughTokens.size > nativeDragTokens.size
}

export function registerWebviewDragPassthroughSurface(
  surface: WebviewDragPassthroughSurface
): () => void {
  passthroughSurfaces.add(surface)
  return () => {
    passthroughSurfaces.delete(surface)
  }
}

function notifyWebviewDragPassthroughSurfaces(): void {
  const passthrough = isWebviewDragPassthroughActive()
  // Copied: a surface may enrol or drop out while being notified.
  const notified = Array.from(passthroughSurfaces)
  for (const surface of notified) {
    surface(passthrough)
  }
}

export function acquireWebviewsDragPassthrough({ nativeDrag = false } = {}): () => void {
  const token = Symbol('webview-drag-passthrough')
  let released = false
  passthroughTokens.add(token)
  if (nativeDrag) {
    nativeDragTokens.add(token)
  }
  notifyWebviewDragPassthroughSurfaces()

  return () => {
    if (released) {
      return
    }
    released = true
    passthroughTokens.delete(token)
    nativeDragTokens.delete(token)
    notifyWebviewDragPassthroughSurfaces()
  }
}
