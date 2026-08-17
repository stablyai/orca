/**
 * Which auxiliary window (if any) currently hosts a detached tab group.
 *
 * Terminal panes do not render inside the tab-group body — `TerminalOverlaySlot`
 * renders them in a sibling overlay layer and positions them over the body with
 * CSS anchor positioning. That only works within one document, so when a group
 * is portaled into an aux window its panes must follow. This registry is how
 * the overlay slot finds the container to portal into.
 */
type Listener = () => void

const containersByGroupId = new Map<string, HTMLElement>()
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function registerAuxPaneContainer(groupId: string, container: HTMLElement): void {
  containersByGroupId.set(groupId, container)
  emit()
}

export function unregisterAuxPaneContainer(groupId: string): void {
  if (containersByGroupId.delete(groupId)) {
    emit()
  }
}

export function getAuxPaneContainer(groupId: string | undefined): HTMLElement | null {
  return groupId ? (containersByGroupId.get(groupId) ?? null) : null
}

export function getAuxPaneContainerForDocument(ownerDocument: Document): HTMLElement | null {
  for (const container of containersByGroupId.values()) {
    if (container.ownerDocument === ownerDocument) {
      return container
    }
  }
  return null
}

export function getPaneDocuments(): Document[] {
  const paneDocuments = [
    document,
    ...new Set(Array.from(containersByGroupId.values(), (container) => container.ownerDocument))
  ]
  return paneDocuments.sort(
    (left, right) => Number(right.hasFocus?.() === true) - Number(left.hasFocus?.() === true)
  )
}

export function getAuxPaneGroupIdForTarget(target: EventTarget | null): string | null {
  const ownerDocument = (target as Node | null)?.ownerDocument
  if (!ownerDocument) {
    return null
  }
  for (const [groupId, container] of containersByGroupId) {
    if (container.ownerDocument === ownerDocument) {
      return groupId
    }
  }
  return null
}

/**
 * True when any detached pane's window is currently visible.
 *
 * The hidden-PTY delivery gate asks "is the app in the foreground" by reading
 * the main document's `visibilityState`. With a detached pane that answer is
 * wrong in the dangerous direction: Chromium marks the main webContents hidden
 * when it is minimized *or merely covered* — including by the aux window itself
 * — and the gate then drops bytes for a terminal the user is actively watching.
 *
 * ponytail: coarse on purpose — any visible aux window keeps delivery on for
 * every pane, rather than resolving each pane's own document. Per-pane
 * resolution needs a container handle threaded through PtyConnectionDeps; do
 * that if background panes ever prove expensive enough to matter.
 */
export function isAnyAuxPaneDocumentVisible(): boolean {
  for (const container of containersByGroupId.values()) {
    if (container.ownerDocument.visibilityState === 'visible') {
      return true
    }
  }
  return false
}

export function subscribeToAuxPaneContainers(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Register a DOM listener on the main window and on every detached pane window,
 * keeping the set in sync as windows open and close.
 *
 * DOM events do not cross documents: a listener on the opener never sees a
 * child document's keydown. Anything doing global event delegation that must
 * also work inside a detached pane has to register per window.
 *
 * App-level `CustomEvent` buses are the opposite case — those stay on the
 * opener window only, so both sides agree on one bus.
 */
export function addEventListenerOnAllWindows<K extends keyof WindowEventMap>(
  type: K,
  handler: (event: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions
): () => void {
  const attached = new Set<Window>()

  const sync = (): void => {
    const wanted = new Set<Window>([window])
    for (const container of containersByGroupId.values()) {
      const view = container.ownerDocument.defaultView
      if (view) {
        wanted.add(view)
      }
    }
    for (const view of attached) {
      if (!wanted.has(view)) {
        view.removeEventListener(type, handler as EventListener, options)
        attached.delete(view)
      }
    }
    for (const view of wanted) {
      if (!attached.has(view)) {
        view.addEventListener(type, handler as EventListener, options)
        attached.add(view)
      }
    }
  }

  sync()
  const unsubscribe = subscribeToAuxPaneContainers(sync)
  return () => {
    unsubscribe()
    for (const view of attached) {
      view.removeEventListener(type, handler as EventListener, options)
    }
    attached.clear()
  }
}

export function addEventListenerOnAllDocuments(
  type: string,
  handler: EventListener,
  options?: boolean | AddEventListenerOptions
): () => void {
  const attached = new Set<Document>()
  const sync = (): void => {
    const wanted = new Set<Document>([document])
    for (const container of containersByGroupId.values()) {
      wanted.add(container.ownerDocument)
    }
    for (const target of attached) {
      if (!wanted.has(target)) {
        target.removeEventListener(type, handler, options)
        attached.delete(target)
      }
    }
    for (const target of wanted) {
      if (!attached.has(target)) {
        target.addEventListener(type, handler, options)
        attached.add(target)
      }
    }
  }
  sync()
  const unsubscribe = subscribeToAuxPaneContainers(sync)
  return () => {
    unsubscribe()
    for (const target of attached) {
      target.removeEventListener(type, handler, options)
    }
    attached.clear()
  }
}
