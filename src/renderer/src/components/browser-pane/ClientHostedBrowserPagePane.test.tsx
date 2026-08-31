// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  publishMetadata: vi.fn(),
  createBrowserTab: vi.fn(async () => true),
  addressBar: {
    current: null as {
      value: string
      onNavigate: (value: string) => void
      inputRef: React.RefObject<HTMLInputElement | null>
    } | null
  }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: mocks.createBrowserTab
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), message: vi.fn() }
}))

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}

vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))

vi.mock('./assemble-chrome/BrowserAddressBar', () => ({
  // Suggestions and select-on-focus are the shared bar's own suites; what matters here is that
  // the pane hands it the ref the chrome focus rules aim at.
  default: (props: {
    value: string
    onNavigate: (value: string) => void
    inputRef: React.RefObject<HTMLInputElement | null>
  }) => {
    mocks.addressBar.current = props
    return <input aria-label="Address" ref={props.inputRef} value={props.value} readOnly />
  }
}))

import { useAppStore } from '@/store'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import { requestBrowserFocus } from './host-guest/browser-focus'
import { installClientHostedPaneApi } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

describe('ClientHostedBrowserPagePane', () => {
  beforeEach(() => {
    mocks.attach.mockReset()
    mocks.publishMetadata.mockReset().mockResolvedValue({ status: 'published', accepted: true })
    // Download, popup and permission notices subscribe on mount; each has its own suite.
    installClientHostedPaneApi({ browser: { publishClientPageMetadata: mocks.publishMetadata } })
  })
  afterEach(() => cleanup())

  it('attaches the exact retained guest once and keeps focus changes local', () => {
    const { webview, focus } = createWebview()
    const detach = vi.fn()
    mocks.attach.mockReturnValue(retainedAttachment(webview, detach))
    const onUpdatePageState = vi.fn()
    const onSetUrl = vi.fn()
    const view = render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive={false}
        onUpdatePageState={onUpdatePageState}
        onSetUrl={onSetUrl}
      />
    )

    expect(mocks.attach).toHaveBeenCalledTimes(1)
    expect(mocks.attach).toHaveBeenCalledWith(
      { browserPageId: 'page-a', pageHostGeneration: 7 },
      expect.any(HTMLElement)
    )
    view.rerender(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={onUpdatePageState}
        onSetUrl={onSetUrl}
      />
    )

    expect(mocks.attach).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('updates local chrome from guest navigation without remote stream work', () => {
    const { webview, setUrl, setTitle } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    const onUpdatePageState = vi.fn()
    const onSetUrl = vi.fn()
    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={onUpdatePageState}
        onSetUrl={onSetUrl}
      />
    )
    onUpdatePageState.mockClear()
    onSetUrl.mockClear()
    setUrl('https://remote.internal/path')
    setTitle('Remote page')

    act(() => webview.dispatchEvent(new Event('did-navigate')))

    expect(onSetUrl).toHaveBeenCalledWith('page-a', 'https://remote.internal/path', {
      preserveLoadError: true
    })
    expect(onUpdatePageState).toHaveBeenCalledWith(
      'page-a',
      expect.objectContaining({
        title: 'Remote page',
        loading: false,
        canGoBack: true,
        canGoForward: false
      })
    )
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe(
      'https://remote.internal/path'
    )
  })

  it('searches non-URL address input like the local pane instead of forcing a host', () => {
    const { webview } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    const onUpdatePageState = vi.fn()
    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={onUpdatePageState}
        onSetUrl={vi.fn()}
      />
    )

    act(() => mocks.addressBar.current?.onNavigate('google maps'))
    expect(webview.loadURL).toHaveBeenCalledWith('https://www.google.com/search?q=google%20maps')

    onUpdatePageState.mockClear()
    act(() => mocks.addressBar.current?.onNavigate('javascript:alert(1)'))
    expect(webview.loadURL).toHaveBeenCalledTimes(1)
    expect(onUpdatePageState).toHaveBeenCalledWith(
      'page-a',
      expect.objectContaining({
        loadError: expect.objectContaining({
          description: 'Enter a valid http(s) or localhost URL.'
        })
      })
    )
  })

  it('surfaces main-frame load failures and ignores aborted races', () => {
    const { webview } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    const onUpdatePageState = vi.fn()
    const view = render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={onUpdatePageState}
        onSetUrl={vi.fn()}
      />
    )
    onUpdatePageState.mockClear()

    act(() =>
      webview.dispatchEvent(
        Object.assign(new Event('did-fail-load'), {
          errorCode: -3,
          errorDescription: 'ERR_ABORTED',
          validatedURL: 'https://replaced.internal/',
          isMainFrame: true
        })
      )
    )
    expect(onUpdatePageState).not.toHaveBeenCalled()

    act(() =>
      webview.dispatchEvent(
        Object.assign(new Event('did-fail-load'), {
          errorCode: -105,
          errorDescription: 'ERR_NAME_NOT_RESOLVED',
          validatedURL: 'https://google%20maps/',
          isMainFrame: true
        })
      )
    )
    const loadError = {
      code: -105,
      description: 'ERR_NAME_NOT_RESOLVED',
      validatedUrl: 'https://google%20maps/'
    }
    expect(onUpdatePageState).toHaveBeenCalledWith('page-a', { loading: false, loadError })
    // Why: did-stop-loading follows did-fail-load and must not wipe the failure.
    onUpdatePageState.mockClear()
    act(() => webview.dispatchEvent(new Event('did-stop-loading')))
    expect(onUpdatePageState).toHaveBeenCalledWith('page-a', expect.objectContaining({ loadError }))

    view.rerender(
      <ClientHostedBrowserPagePane
        browserTab={{ ...page(), loadError }}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={onUpdatePageState}
        onSetUrl={vi.fn()}
      />
    )
    // Why: after chrome-error://, reload() only refreshes the error page — retry must force
    // navigation back to the attempted URL, exactly as the local pane's Retry does.
    act(() => screen.getByText('Retry').click())
    expect(webview.reload).not.toHaveBeenCalled()
    expect(webview.src).toBe(normalizeBrowserNavigationUrl(loadError.validatedUrl))
  })

  it('shows exact-generation unavailability without creating a fallback guest', () => {
    mocks.attach.mockReturnValue(null)

    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={{ ...PLACEMENT, pageHostGeneration: 8 }}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    )

    expect(mocks.attach).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Client-hosted browser unavailable')).not.toBeNull()
    expect(document.querySelector('webview')).toBeNull()
  })

  it('escapes an unrenderable page to a NEW server-placed page at its last committed URL', async () => {
    mocks.attach.mockReturnValue(null)
    mocks.createBrowserTab.mockClear()

    render(
      <ClientHostedBrowserPagePane
        browserTab={{ ...page(), url: 'https://remote.internal/path' }}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    )

    expect(screen.getByText(/Signed-in and other transient page state may differ/)).not.toBeNull()
    await act(async () => {
      screen.getByRole('button', { name: 'Reopen on server' }).click()
    })

    expect(mocks.createBrowserTab).toHaveBeenCalledWith({
      worktreeId: 'worktree-a',
      environmentId: 'environment-a',
      url: 'https://remote.internal/path',
      placementPreference: 'server',
      focusOnCreate: true
    })
  })

  it('requests the one-time intro tour on the first active client-hosted page', async () => {
    const { useAppStore } = await import('@/store')
    const prior = {
      persistedUIReady: useAppStore.getState().persistedUIReady,
      contextualToursSeenIds: useAppStore.getState().contextualToursSeenIds,
      activeContextualTourId: useAppStore.getState().activeContextualTourId
    }
    useAppStore.setState({
      persistedUIReady: true,
      contextualToursSeenIds: [],
      activeContextualTourId: null
    })
    const { webview } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    try {
      render(
        <ClientHostedBrowserPagePane
          browserTab={page()}
          workspaceId="workspace-a"
          chromeShortcutScope="focused"
          runtimeEnvironmentId="environment-a"
          worktreeId="worktree-a"
          placement={PLACEMENT}
          isActive={true}
          onUpdatePageState={vi.fn()}
          onSetUrl={vi.fn()}
        />
      )
      // Why: happy-dom rects are zero-sized and the tour gate requires a measurable target.
      const target = document.querySelector<HTMLElement>(
        '[data-contextual-tour-target="client-hosted-browser-controls"]'
      )
      expect(target).not.toBeNull()
      target!.getBoundingClientRect = () => new DOMRect(0, 0, 400, 32)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(useAppStore.getState().activeContextualTourId).toBe('client-hosted-browser')
    } finally {
      useAppStore.setState(prior)
    }
  })

  it('never re-requests the intro tour once it has been seen', async () => {
    const { useAppStore } = await import('@/store')
    const prior = {
      persistedUIReady: useAppStore.getState().persistedUIReady,
      contextualToursSeenIds: useAppStore.getState().contextualToursSeenIds,
      activeContextualTourId: useAppStore.getState().activeContextualTourId
    }
    useAppStore.setState({
      persistedUIReady: true,
      contextualToursSeenIds: ['client-hosted-browser'],
      activeContextualTourId: null
    })
    const { webview } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    try {
      render(
        <ClientHostedBrowserPagePane
          browserTab={page()}
          workspaceId="workspace-a"
          chromeShortcutScope="focused"
          runtimeEnvironmentId="environment-a"
          worktreeId="worktree-a"
          placement={PLACEMENT}
          isActive={true}
          onUpdatePageState={vi.fn()}
          onSetUrl={vi.fn()}
        />
      )
      // Why: same measurable target as the positive case — only seenIds differs.
      const target = document.querySelector<HTMLElement>(
        '[data-contextual-tour-target="client-hosted-browser-controls"]'
      )
      expect(target).not.toBeNull()
      target!.getBoundingClientRect = () => new DOMRect(0, 0, 400, 32)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(useAppStore.getState().activeContextualTourId).toBeNull()
    } finally {
      useAppStore.setState(prior)
    }
  })

  it('publishes full guest metadata through the exact runtime placement', async () => {
    const { webview, setUrl, setTitle } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    )
    setUrl('https://remote.internal/path')
    setTitle('Remote page')

    act(() => webview.dispatchEvent(new Event('did-navigate')))

    await vi.waitFor(() => expect(mocks.publishMetadata).toHaveBeenCalledTimes(2))
    expect(mocks.publishMetadata).toHaveBeenLastCalledWith({
      environmentId: 'environment-a',
      params: {
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        browserPageId: 'page-a',
        pageHostGeneration: 7,
        revision: 2,
        url: 'https://remote.internal/path',
        title: 'Remote page',
        loading: false,
        canGoBack: true,
        canGoForward: false
      }
    })
  })
})

describe('ClientHostedBrowserPagePane address bar parity', () => {
  let frameCallbacks: FrameRequestCallback[] = []

  beforeEach(() => {
    frameCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    installClientHostedPaneApi()
    useAppStore.setState({
      browserUrlHistory: [],
      pendingAddressBarFocusByPageId: {},
      pendingAddressBarFocusByTabId: {}
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function flushFrames(cycles = 8): void {
    for (let index = 0; index < cycles; index += 1) {
      const pending = frameCallbacks
      frameCallbacks = []
      for (const callback of pending) {
        callback(0)
      }
    }
  }

  it('opens a new blank tab in the address bar instead of handing focus to the guest', () => {
    const { webview, focus } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    useAppStore.setState({
      pendingAddressBarFocusByPageId: { 'page-a': true },
      pendingAddressBarFocusByTabId: { 'page-a': true }
    })

    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    )
    act(() => flushFrames())

    const input = screen.getByLabelText('Address') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(focus).not.toHaveBeenCalled()
  })

  it('still hands focus to the guest when the tab opens on a real page', () => {
    const { webview, focus, setUrl } = createWebview()
    setUrl('https://remote.internal/path')
    mocks.attach.mockReturnValue(retainedAttachment(webview))

    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    )
    act(() => flushFrames())

    expect(focus).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(screen.getByLabelText('Address'))
  })

  it('gives the guest focus back after the palette hands the address bar a turn', () => {
    const { webview, focus, setUrl } = createWebview()
    setUrl('https://remote.internal/path')
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    const renderPane = (isActive: boolean): React.JSX.Element => (
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive={isActive}
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    )
    const view = render(renderPane(true))
    act(() => flushFrames())
    focus.mockClear()

    // Why: dismissing Cmd+J on a browser surface re-requests address-bar focus, and this pane
    // has none of the local pane's load handlers to clear the latch afterwards.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      act(() => requestBrowserFocus({ pageId: 'page-a', target: 'address-bar' }))
      act(() => flushFrames())
      expect(document.activeElement).toBe(screen.getByLabelText('Address'))
      view.rerender(renderPane(false))
      view.rerender(renderPane(true))
      act(() => flushFrames())
      expect(focus).toHaveBeenCalledTimes(cycle + 1)
    }
  })

  it('takes focus off the guest itself when the chord claims the address bar', () => {
    // Why: the chord is Cmd+L on macOS and Ctrl+L everywhere else, so the platform can't be left
    // to whatever the test runner reports.
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    })
    const { webview, blur, setUrl } = createWebview()
    setUrl('https://remote.internal/path')
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    )
    act(() => flushFrames())

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })
      )
    })

    // Why: the guest is its own WebContents, so focusing a renderer input leaves it holding
    // keyboard focus until it is told to let go.
    expect(blur).toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByLabelText('Address'))
  })

  it('files guest navigations into the URL history the address bar suggests from', () => {
    const { webview, setUrl, setTitle } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    )
    // Why: the initial sync sees about:blank, which never belongs in history.
    expect(useAppStore.getState().browserUrlHistory).toHaveLength(0)

    setUrl('https://remote.internal/docs')
    setTitle('Remote docs')
    act(() => webview.dispatchEvent(new Event('did-navigate')))

    expect(useAppStore.getState().browserUrlHistory).toEqual([
      expect.objectContaining({ url: 'https://remote.internal/docs', title: 'Remote docs' })
    ])
  })
})

function page(): BrowserPage {
  return {
    id: 'page-a',
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: 'about:blank',
    title: 'New Tab',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function createWebview(): {
  webview: Electron.WebviewTag
  focus: ReturnType<typeof vi.fn>
  blur: ReturnType<typeof vi.fn>
  setUrl(url: string): void
  setTitle(title: string): void
} {
  const webview = document.createElement('webview') as Electron.WebviewTag
  let url = 'about:blank'
  let title = 'New Tab'
  const focus = vi.fn()
  const blur = vi.fn()
  Object.assign(webview, {
    getURL: vi.fn(() => url),
    getTitle: vi.fn(() => title),
    isLoading: vi.fn(() => false),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => false),
    focus,
    blur,
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    loadURL: vi.fn(async () => {})
  })
  return {
    webview,
    focus,
    blur,
    setUrl: (nextUrl) => {
      url = nextUrl
    },
    setTitle: (nextTitle) => {
      title = nextTitle
    }
  }
}

function retainedAttachment(webview: Electron.WebviewTag, detach = vi.fn()) {
  let revision = 0
  return {
    webview,
    detach,
    nextMetadataRevision: vi.fn(() => ++revision)
  }
}
