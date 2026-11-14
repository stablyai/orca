import type { BrowserGuestMetadata } from '../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'

type Listener = (state: BrowserGuestMetadata | null) => void
type GuestMetadataEntry = {
  browserPageId?: string
  state?: BrowserGuestMetadata
  applicable: boolean
  presentationRequest?: object
  stopObserving?: () => void
}
const guests = new Map<number, GuestMetadataEntry>()
const listeners = new Map<number, Set<Listener>>()
const initialReads = new Map<number, Promise<void>>()
const guestRetirements = new WeakMap<Electron.WebviewTag, () => void>()

function notifyGuest(id: number, entry: GuestMetadataEntry, state: BrowserGuestMetadata): void {
  listeners.get(id)?.forEach((listener) => {
    if (guests.get(id) === entry && entry.applicable && entry.state?.revision === state.revision) {
      listener(state)
    }
  })
}

function retireGuest(id: number, expected?: GuestMetadataEntry): void {
  const entry = guests.get(id)
  if (expected && entry !== expected) {
    return
  }
  const subscribers = listeners.get(id)
  guests.delete(id)
  initialReads.delete(id)
  listeners.delete(id)
  entry?.stopObserving?.()
  subscribers?.forEach((listener) => listener(null))
  subscribers?.clear()
}

function observeGuestDeath(
  id: number,
  webview: Electron.WebviewTag,
  entry: GuestMetadataEntry
): void {
  if (entry.stopObserving) {
    return
  }
  guestRetirements.get(webview)?.()
  const onDestroyed = (): void => retireGuest(id, entry)
  webview.addEventListener('destroyed', onDestroyed)
  guestRetirements.set(webview, onDestroyed)
  entry.stopObserving = () => {
    webview.removeEventListener('destroyed', onDestroyed)
    if (guestRetirements.get(webview) === onDestroyed) {
      guestRetirements.delete(webview)
    }
    delete entry.stopObserving
  }
}

export function retireBrowserGuestMetadata(
  webview: Electron.WebviewTag,
  knownId?: number | null
): void {
  const retire = guestRetirements.get(webview)
  if (retire) {
    retire()
    return
  }
  const id = knownId ?? readBrowserGuestId(webview)
  if (id !== null) {
    retireGuest(id)
  }
}

function refreshGuest(id: number, browserPageId: string): void {
  if (initialReads.has(id)) {
    return
  }
  const request = Promise.resolve()
    .then(() => window.api.browser.getGuestMetadata({ browserPageId, webContentsId: id }))
    .then((state) => {
      if (initialReads.get(id) !== request) {
        return
      }
      initialReads.delete(id)
      if (state === null || state?.kind === 'retired') {
        retireGuest(id)
        return
      }
      if (!state) {
        return
      }
      const entry = guests.get(id) ?? { browserPageId, applicable: true }
      const wasApplicable = entry.applicable
      const previous = entry.state
      if (!previous || previous.revision < state.revision) {
        entry.state = state
      }
      const selected = entry.state ?? state
      entry.browserPageId = browserPageId
      entry.applicable = true
      if (
        !selected.loading ||
        selected.loadError ||
        selected.hasCertificateFailure ||
        selected.errorPage
      ) {
        delete entry.presentationRequest
      }
      guests.set(id, entry)
      if (!wasApplicable || !previous || previous.revision < state.revision) {
        notifyGuest(id, entry, { ...selected, kind: 'snapshot' })
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

export function acceptBrowserGuestMetadata(state: BrowserGuestMetadata): void {
  const id = state.webContentsId
  const entry = guests.get(id) ?? { browserPageId: state.browserPageId, applicable: true }
  if (entry.state && entry.state.revision >= state.revision) {
    return
  }
  if (state.kind === 'retired') {
    retireGuest(id)
    return
  }
  entry.state = state
  entry.browserPageId = state.browserPageId
  if (
    state.kind === 'navigation' ||
    state.kind === 'in-page' ||
    (entry.applicable && (state.kind === 'stop' || state.kind === 'failure'))
  ) {
    delete entry.presentationRequest
  }
  guests.set(id, entry)
  if (entry.applicable) {
    notifyGuest(id, entry, state)
  } else if (state.kind !== 'title') {
    refreshGuest(id, state.browserPageId)
  }
}

export function issueBrowserGuestNavigation<T>(
  webview: Electron.WebviewTag,
  issue: (guest: Electron.WebviewTag) => T
): T
export function issueBrowserGuestNavigation<T>(
  webview: Electron.WebviewTag | null | undefined,
  issue: (guest: Electron.WebviewTag) => T
): T | undefined
export function issueBrowserGuestNavigation<T>(
  webview: Electron.WebviewTag | null | undefined,
  issue: (guest: Electron.WebviewTag) => T
): T | undefined {
  if (!webview) {
    return undefined
  }
  const id = readBrowserGuestId(webview)
  const result = issue(webview)
  if (id === null) {
    return result
  }
  const receipt = {}
  const entry = guests.get(id) ?? { applicable: false }
  entry.applicable = false
  entry.presentationRequest = receipt
  guests.set(id, entry)
  observeGuestDeath(id, webview, entry)
  initialReads.delete(id)
  if (entry.browserPageId) {
    refreshGuest(id, entry.browserPageId)
  }
  // A rejected command ends its presentation claim, never the native observation or a successor's claim.
  if (result instanceof Promise) {
    void result.catch(() => {
      const current = guests.get(id)
      if (current?.presentationRequest === receipt) {
        delete current.presentationRequest
      }
    })
  }
  return result
}

export function browserGuestPreservesRequestedDocument(
  webview: Electron.WebviewTag,
  observedUrl: string,
  requestedUrl: string
): boolean {
  const id = readBrowserGuestId(webview)
  if (id === null || !guests.get(id)?.presentationRequest) {
    return false
  }
  const normalized = (url: string): string => {
    const redacted = redactKagiSessionToken(url)
    return normalizeBrowserNavigationUrl(redacted) ?? redacted
  }
  return normalized(observedUrl) !== normalized(requestedUrl)
}

export function clearBrowserGuestMetadata(): void {
  // oxlint-disable-next-line unicorn/no-useless-spread -- Terminal callbacks may create successor entries.
  for (const id of [...guests.keys()]) {
    retireGuest(id)
  }
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
  return id === null ? undefined : guests.get(id)?.state
}

export function subscribeBrowserGuestMetadata(
  browserPageId: string,
  webview: Electron.WebviewTag,
  listener: Listener
): () => void {
  let guestId: number | null = null
  let boundListener: { id: number; onState: Listener } | null = null
  let disposed = false
  let unsubscribe = (): void => {}
  const bind = (): void => {
    if (disposed) {
      return
    }
    const id = readBrowserGuestId(webview)
    if (id === null) {
      return
    }
    // Why: a retired push for the same guest id clears the cache and its listener set;
    // a re-registered guest must re-arm listeners instead of refreshing into the void.
    if (
      id === guestId &&
      boundListener?.id === id &&
      listeners.get(id)?.has(boundListener.onState)
    ) {
      const entry = guests.get(id)
      if (!entry?.applicable || !entry.state) {
        refreshGuest(id, browserPageId)
      }
      return
    }
    unsubscribe()
    if (guestId !== null) {
      retireGuest(guestId)
    }
    guestId = id
    const onState: Listener = (state) => {
      if (!state || (readBrowserGuestId(webview) === id && state.browserPageId === browserPageId)) {
        listener(state)
      }
    }
    boundListener = { id, onState }
    let subscribers = listeners.get(id)
    if (!subscribers) {
      subscribers = new Set()
      listeners.set(id, subscribers)
    }
    subscribers.add(onState)
    unsubscribe = () => {
      subscribers.delete(onState)
      if (!subscribers.size && listeners.get(id) === subscribers) {
        listeners.delete(id)
      }
    }
    const entry = guests.get(id) ?? { applicable: true }
    entry.browserPageId = browserPageId
    guests.set(id, entry)
    observeGuestDeath(id, webview, entry)
    if (entry.applicable && entry.state) {
      onState({ ...entry.state, kind: 'snapshot' })
    } else {
      refreshGuest(id, browserPageId)
    }
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
