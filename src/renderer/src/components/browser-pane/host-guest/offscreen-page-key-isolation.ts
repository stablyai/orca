type PageKeyHandler = (event: KeyboardEvent) => void

const handlers = new WeakMap<EventTarget, PageKeyHandler>()
const KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const

/**
 * Keys typed into an offscreen page belong to the page alone, as a focused <webview>'s do: they
 * never reach Orca's window-level shortcut handlers. Main already resolved the chords a focused
 * guest forwards before the key got here. Why a window capture listener installed at startup: it
 * is the first listener any key event meets, so stopping it here stops every other one.
 */
function isolate(event: Event): void {
  const handler = handlers.get(event.composedPath()[0])
  if (handler && event instanceof KeyboardEvent) {
    event.stopImmediatePropagation()
    handler(event)
  }
}

for (const type of KEY_EVENTS) {
  window.addEventListener(type, isolate, true)
}

/** Routes key events aimed at `target` (a page's hidden IME textarea) to `handler` only. */
export function routeOffscreenPageKeys(target: EventTarget, handler: PageKeyHandler): () => void {
  handlers.set(target, handler)
  return () => {
    if (handlers.get(target) === handler) {
      handlers.delete(target)
    }
  }
}
