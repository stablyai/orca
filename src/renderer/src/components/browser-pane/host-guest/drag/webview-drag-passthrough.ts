/** Reference-count passthrough for overlapping renderer drags across local guests and retained hosts; registration/show owns applying it to newly hittable surfaces. */

export type WebviewDragPassthroughSurface = (passthrough: boolean) => void

const passthroughTokens = new Set<symbol>()
const passthroughSurfaces = new Set<WebviewDragPassthroughSurface>()

export function isWebviewDragPassthroughActive(): boolean {
  return passthroughTokens.size > 0
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

export function acquireWebviewsDragPassthrough(): () => void {
  const token = Symbol('webview-drag-passthrough')
  let released = false
  passthroughTokens.add(token)
  notifyWebviewDragPassthroughSurfaces()

  return () => {
    if (released) {
      return
    }
    released = true
    passthroughTokens.delete(token)
    notifyWebviewDragPassthroughSurfaces()
  }
}
