// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import type {
  DesktopBrowserViewEvent,
  DesktopBrowserViewState
} from '../../../../../shared/desktop-browser-view-protocol'
import type { BrowserTabPageState } from '../describe-page/browser-page-types'
import type { DesktopBrowserPage } from './desktop-browser-page-registry'
import { bindDesktopBrowserPageEvents } from './desktop-browser-page-events'

const ref = <T>(current: T): MutableRefObject<T> => ({ current })

afterEach(() => document.body.replaceChildren())

function state(overrides: Partial<DesktopBrowserViewState> = {}): DesktopBrowserViewState {
  return {
    browserPageId: 'page',
    generation: 'generation',
    revision: 1,
    url: 'https://example.test/',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    loadError: null,
    zoomLevel: 0,
    focused: false,
    ...overrides
  }
}

function createHarness(initial = state()) {
  const listeners = new Set<(event: DesktopBrowserViewEvent) => void>()
  const updates: BrowserTabPageState[] = []
  const persisted: string[] = []
  const address = document.createElement('input')
  document.body.append(address)
  const page = {
    state: initial,
    args: { browserPageId: 'page', url: 'https://attempted.test/' },
    ready: false,
    subscribe: (listener: (event: DesktopBrowserViewEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bindDesktopBrowserPageEvents reads only state, args, ready and subscribe from this controlled fixture.
  const desktopPage = page as unknown as DesktopBrowserPage
  const args = {
    browserTabId: 'tab',
    browserTabUrl: 'https://attempted.test/',
    faviconUrlRef: ref<string | null>(null),
    browserTabUrlRef: ref('https://attempted.test/'),
    addressBarValueRef: ref('https://attempted.test/'),
    addressBarInputRef: ref<HTMLInputElement | null>(address),
    activeLoadFailureRef: ref(null),
    lastKnownWebviewUrlRef: ref<string | null>(null),
    trackNextLoadingEventRef: ref(true),
    keepAddressBarFocusRef: ref(false),
    recoveryNavigationValidationRef: ref(null),
    invalidateBrowserAnnotationDocumentRef: ref(vi.fn()),
    onSetUrlRef: ref((_: string, url: string) => persisted.push(url)),
    onUpdatePageStateRef: ref((_: string, update: BrowserTabPageState) => updates.push(update)),
    addBrowserHistoryEntryRef: ref(vi.fn()),
    setAddressBarValue: vi.fn(),
    annotationViewportBridgeTokenRef: ref('token'),
    setBrowserOverlayViewport: vi.fn(),
    focusAddressBarNow: () => false,
    onReady: vi.fn(),
    onGone: vi.fn(),
    onFocus: vi.fn(),
    onZoom: vi.fn(),
    onFullNavigation: vi.fn()
  }
  const emit = (event: DesktopBrowserViewEvent): void => {
    if (event.kind === 'state') {
      page.state = event.state
    }
    for (const listener of listeners) {
      listener(event)
    }
  }
  return { desktopPage, args, emit, updates, persisted, address }
}

describe('desktop browser page events', () => {
  it('keeps a chrome error as an attempted-url failure rather than persisting the internal URL', () => {
    const h = createHarness(state({ loading: true }))
    const dispose = bindDesktopBrowserPageEvents(h.desktopPage, h.args)
    h.persisted.length = 0
    h.emit({
      kind: 'state',
      state: state({ revision: 2, url: 'chrome-error://chromewebdata/', loading: false })
    })
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        loading: false,
        loadError: expect.objectContaining({ validatedUrl: 'https://attempted.test/' })
      })
    )
    expect(h.persisted).toEqual([])
    dispose()
  })

  it('uses redirected committed URLs while preserving a focused typed address', () => {
    const h = createHarness()
    h.address.focus()
    const dispose = bindDesktopBrowserPageEvents(h.desktopPage, h.args)
    h.persisted.length = 0
    h.args.setAddressBarValue.mockClear()
    h.emit({
      kind: 'state',
      state: state({ revision: 2, url: 'https://redirected.test/final', title: 'Final' })
    })
    h.emit({
      kind: 'navigation-commit',
      browserPageId: 'page',
      generation: 'generation',
      sameDocument: false,
      url: 'https://redirected.test/final'
    })
    expect(h.persisted).toEqual(['https://redirected.test/final'])
    expect(h.args.setAddressBarValue).not.toHaveBeenCalled()
    expect(h.args.onFullNavigation).toHaveBeenCalledOnce()
    dispose()
  })
})
