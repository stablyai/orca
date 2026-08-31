/** Pointer passthrough for Electron guests held open across a renderer-owned drag.
 *
 * Every surface that can swallow the document pointer stream enrols here — the local
 * pane's registered <webview> and the client-hosted page's body-level retained host —
 * so one acquire covers all of them. Acquires are reference counted: tab drags and
 * terminal pane drags can overlap, and passthrough must outlive whichever releases first.
 *
 * Enrolment does not settle the new surface: a guest that appears mid-drag is put in
 * passthrough by the path that makes it hittable in the first place (a local webview by
 * its registration, a retained host by its show), so doing it here too would be a second
 * writer with no state of its own to observe.
 */

/** Called with the passthrough state whenever it changes. */
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
  // Why: renderer-owned pointer drags (dnd-kit tab drags, terminal pane reorders) do
  // not emit HTML dragstart/dragend, but Electron guests can still steal the pointer
  // stream unless they are temporarily transparent.
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
