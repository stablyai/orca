import { describe, expect, it, vi } from 'vitest'
import { createBrowserPageWebviewNavigationHandlers } from './browser-page-webview-navigation-handlers'
import { createBrowserPageWebviewLoadingHandlers } from './browser-page-webview-loading-handlers'
import type { BrowserTabPageState } from '../describe-page/browser-page-types'

const TAB_ID = 'tab-1'
const GITHUB_ICON = 'https://github.githubassets.com/favicons/favicon.png'

function createHarness(startUrl: string) {
  const updates: BrowserTabPageState[] = []
  const committedUrl = { current: startUrl }
  const webview = {
    getURL: () => committedUrl.current,
    getTitle: () => 'title',
    canGoBack: () => false,
    canGoForward: () => false,
    src: startUrl
  } as unknown as Electron.WebviewTag
  const faviconUrlRef = { current: null as string | null }
  const onUpdatePageStateRef = {
    current: (_tabId: string, next: BrowserTabPageState) => {
      updates.push(next)
    }
  }
  const ref = <T>(value: T) => ({ current: value })
  const navigation = createBrowserPageWebviewNavigationHandlers({
    webview,
    browserTabId: TAB_ID,
    browserTabUrl: startUrl,
    recoveryNavigationValidationRef: ref(null),
    activeLoadFailureRef: ref(null),
    // Why the destination, not the current document: Orca-driven navigations set this ref before
    // assigning src, which is exactly the case the origin check must not read it for.
    lastKnownWebviewUrlRef: ref<string | null>(startUrl),
    addressBarInputRef: ref(null),
    onSetUrlRef: ref(vi.fn()),
    onUpdatePageStateRef,
    addBrowserHistoryEntryRef: ref(vi.fn()),
    faviconUrlRef,
    setAddressBarValue: vi.fn(),
    annotationViewportBridgeTokenRef: ref('token'),
    setBrowserOverlayViewport: vi.fn()
  })
  const loading = createBrowserPageWebviewLoadingHandlers({
    webview,
    browserTabId: TAB_ID,
    faviconUrlRef,
    browserTabUrlRef: ref(startUrl),
    addressBarValueRef: ref(startUrl),
    addressBarInputRef: ref(null),
    activeLoadFailureRef: ref(null),
    lastKnownWebviewUrlRef: ref<string | null>(startUrl),
    trackNextLoadingEventRef: ref(true),
    keepAddressBarFocusRef: ref(false),
    recoveryNavigationValidationRef: ref(null),
    clearBrowserPageAnnotationsRef: ref(vi.fn()),
    onUpdatePageStateRef,
    onSetUrlRef: ref(vi.fn()),
    setPendingAnnotationPayload: vi.fn(),
    setBrowserOverlayViewport: vi.fn(),
    setAddressBarValue: vi.fn(),
    focusAddressBarNow: () => false
  })

  const navigateTo = (url: string): void => {
    loading.handleDidStartLoading()
    navigation.handleDidStartNavigation({
      isMainFrame: true,
      isInPlace: false,
      url
    } as Electron.DidStartNavigationEvent)
    committedUrl.current = url
  }

  return { faviconUrlRef, updates, navigation, navigateTo, committedUrl }
}

describe('favicon retention across navigations', () => {
  it('keeps the icon when Chromium will not re-announce it for a same-origin load', () => {
    const harness = createHarness('https://github.com/alibaba/jvm-sandbox')
    harness.navigation.handleFaviconUpdate({ favicons: [GITHUB_ICON] })
    expect(harness.faviconUrlRef.current).toBe(GITHUB_ICON)

    // Chromium emits no page-favicon-updated here: the icon URL list is unchanged.
    harness.navigateTo('https://github.com/btraceio/btrace')

    expect(harness.faviconUrlRef.current).toBe(GITHUB_ICON)
    expect(harness.updates.some((update) => update.faviconUrl === null)).toBe(false)
  })

  it('drops the icon when the navigation leaves the origin', () => {
    const harness = createHarness('https://github.com/nodejs/node')
    harness.navigation.handleFaviconUpdate({ favicons: [GITHUB_ICON] })

    harness.navigateTo('https://x.com/home')

    expect(harness.faviconUrlRef.current).toBeNull()
    expect(harness.updates.at(-1)).toEqual({ faviconUrl: null })
  })

  it('drops the icon when a same-origin navigation redirects to another origin', () => {
    const harness = createHarness('https://github.com/nodejs/node')
    harness.navigation.handleFaviconUpdate({ favicons: [GITHUB_ICON] })
    harness.navigateTo('https://github.com/login')

    harness.navigation.handleDidRedirectNavigation({
      isMainFrame: true,
      isInPlace: false,
      url: 'https://example.com/after-login'
    } as Electron.DidRedirectNavigationEvent)

    expect(harness.faviconUrlRef.current).toBeNull()
    expect(harness.updates.at(-1)).toEqual({ faviconUrl: null })
  })

  it('does not clear on a same-document navigation', () => {
    const harness = createHarness('https://github.com/nodejs/node')
    harness.navigation.handleFaviconUpdate({ favicons: [GITHUB_ICON] })

    harness.navigation.handleDidStartNavigation({
      isMainFrame: true,
      isInPlace: true,
      url: 'https://example.com/'
    } as Electron.DidStartNavigationEvent)

    expect(harness.faviconUrlRef.current).toBe(GITHUB_ICON)
  })

  it('reports loading without touching the icon on did-start-loading', () => {
    const harness = createHarness('https://github.com/nodejs/node')
    harness.navigation.handleFaviconUpdate({ favicons: [GITHUB_ICON] })
    harness.updates.length = 0

    harness.navigateTo('https://github.com/nodejs/undici')

    expect(harness.updates).toEqual([{ loading: true }])
  })

  it('takes the first renderable icon rather than the first declared one', () => {
    const harness = createHarness('https://example.com/')
    harness.navigation.handleFaviconUpdate({
      favicons: ['data:,', 'https://example.com/icon.png']
    })
    expect(harness.faviconUrlRef.current).toBe('https://example.com/icon.png')

    harness.navigation.handleFaviconUpdate({ favicons: ['data:,'] })
    expect(harness.faviconUrlRef.current).toBeNull()
  })
})
