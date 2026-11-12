import type { BrowserGuestMetadata } from '../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import {
  acceptBrowserGuestMetadata,
  clearBrowserGuestMetadata
} from './host-guest/browser-guest-metadata-cache'
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
  clearBrowserGuestMetadata()
  guestStates.clear()
  const inert = (): (() => void) => () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        getGuestMetadata: vi.fn(async ({ webContentsId }: { webContentsId: number }) =>
          guestStates.get(webContentsId)
        ),
        onGuestMetadata: inert,
        onGuestEscape: inert,
        onPopup: inert,
        onPermissionDenied: inert,
        onContextMenuRequested: inert,
        onContextMenuDismissed: inert,
        onTargetUrlChanged: inert,
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

const guestStates = new Map<number, BrowserGuestMetadata>()

/** Supplies the main-owned observation the production preload bridge delivers. */
export function reportClientHostedGuestMetadata(
  patch: Partial<BrowserGuestMetadata> & { webContentsId: number }
): BrowserGuestMetadata {
  const previous = guestStates.get(patch.webContentsId)
  const state: BrowserGuestMetadata = {
    browserPageId: 'page-a',
    navigationRevision: 1,
    kind: 'snapshot',
    url: 'about:blank',
    title: 'New Tab',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    errorPage: false,
    loadError: null,
    hasCertificateFailure: false,
    ...previous,
    ...patch,
    revision: (previous?.revision ?? 0) + 1
  }
  guestStates.set(state.webContentsId, state)
  acceptBrowserGuestMetadata(state)
  return state
}
