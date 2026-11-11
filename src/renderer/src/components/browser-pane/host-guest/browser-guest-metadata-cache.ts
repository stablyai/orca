import type { BrowserGuestMetadata } from '../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'

type Listener = (state: BrowserGuestMetadata | null) => void
const snapshots = new Map<number, BrowserGuestMetadata>()
const listeners = new Map<number, Set<Listener>>()
const initialReads = new Map<number, Promise<void>>()

export function acceptBrowserGuestMetadata(state: BrowserGuestMetadata): void {
  const previous = snapshots.get(state.webContentsId)
  if (previous && previous.revision >= state.revision) {
    return
  }
  if (state.kind === 'retired') {
    snapshots.delete(state.webContentsId)
    initialReads.delete(state.webContentsId)
  } else {
    snapshots.set(state.webContentsId, state)
  }
  listeners.get(state.webContentsId)?.forEach((listener) => listener(state))
}

export function clearBrowserGuestMetadata(): void {
  snapshots.clear()
  initialReads.clear()
}

export function readBrowserGuestId(webview: Electron.WebviewTag): number | null {
  try {
    return webview.getWebContentsId()
  } catch {
    return null
  }
}

export function cachedBrowserGuestMetadata(
  webview: Electron.WebviewTag
): BrowserGuestMetadata | undefined {
  const id = readBrowserGuestId(webview)
  return id === null ? undefined : snapshots.get(id)
}

export function subscribeBrowserGuestMetadata(
  browserPageId: string,
  webview: Electron.WebviewTag,
  listener: Listener
): () => void {
  let guestId: number | null = null
  let disposed = false
  let unsubscribe = (): void => {}
  const bind = (): void => {
    if (disposed) {
      return
    }
    const id = readBrowserGuestId(webview)
    if (id === null || id === guestId) {
      return
    }
    unsubscribe()
    guestId = id
    const onState: Listener = (state) => {
      if (readBrowserGuestId(webview) === id && (!state || state.browserPageId === browserPageId)) {
        listener(state)
      }
    }
    let subscribers = listeners.get(id)
    if (!subscribers) {
      subscribers = new Set()
      listeners.set(id, subscribers)
    }
    subscribers.add(onState)
    unsubscribe = () => {
      subscribers.delete(onState)
      if (!subscribers.size) {
        listeners.delete(id)
      }
    }
    const cached = snapshots.get(id)
    if (cached) {
      onState({ ...cached, kind: 'snapshot' })
      return
    }
    if (initialReads.has(id)) {
      return
    }
    const request = window.api.browser
      .getGuestMetadata({ browserPageId, webContentsId: id })
      .then((state) => {
        if (initialReads.get(id) !== request) {
          return
        }
        if (state) {
          acceptBrowserGuestMetadata(state)
        } else if (state === null && !snapshots.has(id)) {
          listeners.get(id)?.forEach((notify) => notify(null))
        }
      })
      .catch(() => {})
      .finally(() => {
        if (initialReads.get(id) === request) {
          initialReads.delete(id)
        }
      })
    initialReads.set(id, request)
  }
  webview.addEventListener('did-attach', bind)
  webview.addEventListener('dom-ready', bind)
  bind()
  return () => {
    disposed = true
    unsubscribe()
    webview.removeEventListener('did-attach', bind)
    webview.removeEventListener('dom-ready', bind)
  }
}
