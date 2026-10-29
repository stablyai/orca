import { vi } from 'vitest'

type Listener<T> = (event: T) => void

/** A subscription channel a test can drive, standing in for one preload `on…` bridge. */
export type PaneChannel<T> = {
  subscribe: (callback: Listener<T>) => () => void
  emit: (event: T) => void
}

export function paneChannel<T>(): PaneChannel<T> {
  let listeners: Listener<T>[] = []
  return {
    subscribe: (callback) => {
      listeners.push(callback)
      return () => {
        listeners = listeners.filter((entry) => entry !== callback)
      }
    },
    emit: (event) => {
      // A listener that unsubscribes mid-emit must not shorten the list being walked.
      for (const listener of listeners.slice()) {
        listener(event)
      }
    }
  }
}

/** Provide inert defaults for every mount subscription so new preload channels do not break unrelated tests. */
export function installClientHostedPaneApi(overrides?: {
  browser?: Record<string, unknown>
  ui?: Record<string, unknown>
  shell?: Record<string, unknown>
  runtimeEnvironments?: Record<string, unknown>
}): void {
  const inert = (): (() => void) => () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        onPopup: inert,
        onPermissionDenied: inert,
        onContextMenuRequested: inert,
        onContextMenuDismissed: inert,
        onTargetUrlChanged: inert,
        onGrabModeToggle: inert,
        onGrabActionShortcut: inert,
        setGrabMode: vi.fn(async () => ({ ok: true })),
        awaitGrabSelection: vi.fn(async () => ({ kind: 'cancelled' })),
        cancelGrab: vi.fn(async () => true),
        setAnnotationViewportBridge: vi.fn(async () => true),
        openDevTools: vi.fn(async () => true),
        onDevToolsDockChanged: inert,
        proceedCertificate: vi.fn(async () => ({ ok: true })),
        publishClientPageMetadata: vi.fn(async () => ({ status: 'published', accepted: true })),
        ...overrides?.browser
      },
      ui: {
        onFocusBrowserAddressBar: inert,
        onShowBrowserHistory: inert,
        onFindInBrowserPage: inert,
        onBrowserHistoryNavigate: inert,
        onReloadBrowserPage: inert,
        onHardReloadBrowserPage: inert,
        onZoomBrowserPage: inert,
        getZoomLevel: () => 0,
        writeClipboardText: vi.fn(async () => {}),
        recordFeatureInteraction: vi.fn(async () => ({
          featureInteractions: {},
          contextualToursSeenIds: []
        })),
        set: vi.fn(async () => ({})),
        ...overrides?.ui
      },
      shell: { openUrl: vi.fn(async () => {}), ...overrides?.shell },
      runtimeEnvironments: {
        call: vi.fn(async () => ({ ok: true, result: {} })),
        ...overrides?.runtimeEnvironments
      }
    }
  })
}
