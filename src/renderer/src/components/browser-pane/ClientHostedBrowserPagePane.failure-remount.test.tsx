// @vitest-environment happy-dom
import type { BrowserGuestMetadata } from '../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import {
  cachedBrowserGuestMetadata,
  clearBrowserGuestMetadata
} from './host-guest/browser-guest-metadata-cache'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserCertificateFailure,
  BrowserPage,
  BrowserWorkspace
} from '../../../../shared/browser-workspace-types'

const toastMocks = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn()
}))
vi.mock('sonner', () => ({ toast: toastMocks }))

const mocks = vi.hoisted(() => ({ attach: vi.fn() }))
vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))

import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  installClientHostedPaneApi,
  reportClientHostedGuestMetadata
} from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'
import { clearBrowserPageDeferredNavigation } from './navigate/browser-page-deferred-navigation'

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}
const FAILED_URL = 'https://selfsigned.internal/'

let webview: ReturnType<typeof createWebview>

beforeEach(() => {
  installClientHostedPaneApi()
  webview = createWebview()
  reportClientHostedGuestMetadata({ webContentsId: 42, url: FAILED_URL, title: 'Selfsigned' })
  mocks.attach.mockReturnValue({
    webview,
    detach: vi.fn(),
    nextMetadataRevision: vi.fn(() => 1)
  })
  seedStore()
})

afterEach(() => {
  cleanup()
  clearBrowserPageDeferredNavigation('page-a')
  vi.clearAllMocks()
})

/** Worktree switches unmount chrome while retaining the guest; use the real store because clearing loadError also deletes its certificate record. */
describe('ClientHostedBrowserPagePane failure records across a remount', () => {
  it('issues a staged request before native replay or an unanswered initial publication', async () => {
    const idleA = reportClientHostedGuestMetadata({
      webContentsId: 42,
      url: FAILED_URL,
      title: 'Selfsigned',
      loading: false
    })
    mocks.attach.mockReturnValueOnce(null)
    const staged = render(<StoreDrivenPane />)
    submitUrl('https://requested.internal/b')
    act(() => staged.unmount())
    vi.mocked(window.api.browser.publishClientPageMetadata).mockImplementation(
      () => new Promise(() => {})
    )
    vi.mocked(window.api.browser.getGuestMetadata).mockResolvedValueOnce({
      ...idleA,
      revision: idleA.revision + 1,
      kind: 'snapshot',
      loading: true
    })
    await act(async () => {
      render(<StoreDrivenPane />)
    })
    expect(webview.loadURL).toHaveBeenCalledWith('https://requested.internal/b')
    expect(storedPage()).toMatchObject({
      url: 'https://requested.internal/b',
      title: 'https://requested.internal/b',
      loading: true
    })
    expect(
      vi.mocked(window.api.browser.publishClientPageMetadata).mock.calls[0]?.[0].params
    ).toMatchObject({
      url: 'https://requested.internal/b',
      title: 'https://requested.internal/b',
      loading: true
    })
  })

  it('keeps a requested page through old readback and a successor, then settles Stop at the native document', async () => {
    const staleA = reportClientHostedGuestMetadata({
      webContentsId: 42,
      url: FAILED_URL,
      title: 'Selfsigned',
      loading: false
    })
    clearBrowserGuestMetadata()
    let q1!: (state: BrowserGuestMetadata) => void
    let q2!: (state: BrowserGuestMetadata) => void
    vi.mocked(window.api.browser.getGuestMetadata)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            q1 = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            q2 = resolve
          })
      )
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<StoreDrivenPane />)
    })
    submitUrl('https://requested.internal/b')
    await act(async () => {})
    act(() => view.unmount())
    await act(async () => {
      render(<StoreDrivenPane />)
    })
    await act(async () => {
      q1(staleA)
    })
    expect(storedPage()).toMatchObject({
      url: 'https://requested.internal/b',
      title: 'https://requested.internal/b',
      loading: true
    })
    const sample = reportClientHostedGuestMetadata({
      webContentsId: 42,
      kind: 'snapshot',
      url: FAILED_URL,
      title: 'Outgoing A',
      loading: true
    })
    await act(async () => {
      q2(sample)
    })
    act(() =>
      reportClientHostedGuestMetadata({
        webContentsId: 42,
        kind: 'title',
        title: 'Outgoing A tick',
        loading: true
      })
    )
    expect(storedPage()).toMatchObject({
      url: 'https://requested.internal/b',
      title: 'https://requested.internal/b',
      loading: true
    })
    expect(
      vi.mocked(window.api.browser.publishClientPageMetadata).mock.lastCall?.[0].params
    ).toMatchObject({
      url: 'https://requested.internal/b',
      title: 'https://requested.internal/b',
      loading: true
    })
    expect(cachedBrowserGuestMetadata(webview)?.url).toBe('https://selfsigned.internal/')
    await act(async () =>
      reportClientHostedGuestMetadata({
        webContentsId: 42,
        kind: 'stop',
        title: 'Selfsigned',
        loading: false
      })
    )
    expect(storedPage()).toMatchObject({
      url: 'https://selfsigned.internal/',
      title: 'Selfsigned',
      loading: false
    })
  })

  it('revalidates a healthy Stop after a command read failed', async () => {
    render(<StoreDrivenPane />)
    vi.mocked(window.api.browser.getGuestMetadata).mockRejectedValueOnce(
      new Error('metadata read failed')
    )
    submitUrl('https://requested.internal/b')
    await act(async () => {})
    expect(storedPage()).toMatchObject({ url: 'https://requested.internal/b', loading: true })
    await act(async () =>
      reportClientHostedGuestMetadata({ webContentsId: 42, kind: 'stop', loading: false })
    )
    expect(storedPage()).toMatchObject({
      url: 'https://selfsigned.internal/',
      title: 'Selfsigned',
      loading: false
    })
  })

  it('adopts an already committed page on same-guest readiness after its read failed', async () => {
    render(<StoreDrivenPane />)
    let reject!: (error: Error) => void
    vi.mocked(window.api.browser.getGuestMetadata).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    submitUrl('https://requested.internal/b')
    await act(async () => {})
    act(() =>
      reportClientHostedGuestMetadata({
        webContentsId: 42,
        kind: 'navigation',
        url: 'https://requested.internal/b',
        title: 'Committed B',
        loading: true
      })
    )
    await act(async () => {
      reject(new Error('metadata read failed'))
    })
    await act(async () => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    expect(storedPage()).toMatchObject({
      url: 'https://requested.internal/b',
      title: 'Committed B',
      loading: true
    })
  })

  it('shows a hidden committed document and its live title while another load is pending', async () => {
    let resolve!: (state: BrowserGuestMetadata) => void
    const view = render(<StoreDrivenPane />)
    vi.mocked(window.api.browser.getGuestMetadata).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    submitUrl('https://requested.internal/b')
    await act(async () => {})
    act(() => view.unmount())
    reportClientHostedGuestMetadata({
      webContentsId: 42,
      kind: 'navigation',
      url: 'https://current.internal/c',
      title: 'Current C',
      loading: true
    })
    const sample = reportClientHostedGuestMetadata({
      webContentsId: 42,
      kind: 'snapshot',
      loading: true
    })
    await act(async () => {
      resolve(sample)
    })
    expect(storedPage().loading).toBe(true)
    render(<StoreDrivenPane />)
    expect(storedPage()).toMatchObject({
      url: 'https://current.internal/c',
      title: 'Current C',
      loading: true
    })
    act(() =>
      reportClientHostedGuestMetadata({
        webContentsId: 42,
        kind: 'title',
        title: 'Current C live',
        loading: true
      })
    )
    expect(storedPage()).toMatchObject({
      url: 'https://current.internal/c',
      title: 'Current C live',
      loading: true
    })
  })

  it('retains the saved title until a first committed document exists, including a failed first load', () => {
    reportClientHostedGuestMetadata({
      webContentsId: 42,
      navigationRevision: 0,
      url: '',
      title: '',
      kind: 'snapshot',
      loading: true
    })
    render(<StoreDrivenPane />)
    expect(storedPage().title).toBe('Selfsigned')
    expect(storedPage().loading).toBe(true)
    act(() => reportClientHostedGuestMetadata({ webContentsId: 42, kind: 'start', loading: true }))
    expect(storedPage().title).toBe('Selfsigned')
    act(() => reportClientHostedGuestMetadata({ webContentsId: 42, kind: 'stop', loading: false }))
    expect(storedPage().url).toBe(FAILED_URL)
    expect(storedPage().title).toBe('Selfsigned')
    act(() =>
      reportClientHostedGuestMetadata({
        webContentsId: 42,
        kind: 'failure',
        loading: false,
        loadError: { code: -105, description: 'ERR_NAME_NOT_RESOLVED', validatedUrl: FAILED_URL }
      })
    )
    expect(storedPage().title).toBe('Selfsigned')
  })

  it('reconciles a hidden commit on settlement even when metadata publication never answers', () => {
    vi.mocked(window.api.browser.publishClientPageMetadata).mockImplementation(
      () => new Promise(() => {})
    )
    const view = render(<StoreDrivenPane />)
    act(() => view.unmount())
    reportClientHostedGuestMetadata({
      webContentsId: 42,
      kind: 'navigation',
      url: 'https://example.internal/next',
      loading: true,
      navigationRevision: 2
    })
    render(<StoreDrivenPane />)
    act(() => reportClientHostedGuestMetadata({ webContentsId: 42, kind: 'stop', loading: false }))
    expect(storedPage().url).toBe('https://example.internal/next')
    expect(storedPage().loading).toBe(false)
    expect(storedPage().loadError).toBeNull()
  })

  it('clears a standing failure after a successful same-URL reload', () => {
    render(<StoreDrivenPane />)
    failLoad()
    act(() =>
      reportClientHostedGuestMetadata({
        webContentsId: 42,
        kind: 'start',
        loading: true,
        loadError: null,
        hasCertificateFailure: false
      })
    )
    expect(storedPage().loadError?.validatedUrl).toBe(FAILED_URL)
    act(() =>
      reportClientHostedGuestMetadata({
        webContentsId: 42,
        kind: 'navigation',
        navigationRevision: 2
      })
    )
    expect(storedPage().loadError).toBeNull()
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
    expect(screen.queryByRole('heading', { name: "Connection isn't secure" })).toBeNull()
  })

  it('keeps the failure and the certificate record when the guest still sits on the failed page', () => {
    const view = render(<StoreDrivenPane />)
    failLoad()
    expect(storedPage().loadError?.validatedUrl).toBe(FAILED_URL)
    expect(screen.getByRole('heading', { name: "Connection isn't secure" })).not.toBeNull()

    act(() => view.unmount())
    render(<StoreDrivenPane />)

    expect(storedPage().loadError?.validatedUrl).toBe(FAILED_URL)
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeDefined()
    expect(screen.getByRole('heading', { name: "Connection isn't secure" })).not.toBeNull()
  })

  it('keeps both records when the guest is parked on the Chromium error page', () => {
    const view = render(<StoreDrivenPane />)
    failLoad()

    act(() => view.unmount())
    // Failed guests report chrome-error://chromewebdata/, which matches neither recorded URL.
    reportClientHostedGuestMetadata({ webContentsId: 42, errorPage: true })
    render(<StoreDrivenPane />)

    expect(storedPage().loadError?.validatedUrl).toBe(FAILED_URL)
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeDefined()
    expect(screen.getByRole('heading', { name: "Connection isn't secure" })).not.toBeNull()
  })

  it('clears both records when the guest moved on while the pane was unmounted', () => {
    const view = render(<StoreDrivenPane />)
    failLoad()

    act(() => view.unmount())
    // A navigation while unmounted is observable only through remount sync.
    reportClientHostedGuestMetadata({
      webContentsId: 42,
      kind: 'navigation',
      url: 'https://example.internal/recovered',
      loadError: null,
      hasCertificateFailure: false,
      errorPage: false
    })
    render(<StoreDrivenPane />)

    expect(storedPage().loadError).toBeNull()
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
    expect(screen.queryByRole('heading', { name: "Connection isn't secure" })).toBeNull()
  })
})

function StoreDrivenPane(): React.JSX.Element {
  const browserTab = useAppStore((s) => (s.browserPagesByWorkspace['workspace-a'] ?? [])[0])
  const updateBrowserPageState = useAppStore((s) => s.updateBrowserPageState)
  const setBrowserPageUrl = useAppStore((s) => s.setBrowserPageUrl)
  return (
    <TooltipProvider>
      <ClientHostedBrowserPagePane
        browserTab={browserTab as BrowserPage}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={updateBrowserPageState}
        onSetUrl={setBrowserPageUrl}
      />
    </TooltipProvider>
  )
}

/** Raises the failure the way the guest does, then records the certificate challenge main sends. */
function failLoad(): void {
  act(() => {
    webview.dispatchEvent(
      Object.assign(new Event('did-fail-load'), {
        errorCode: -202,
        errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
        validatedURL: FAILED_URL,
        isMainFrame: true
      })
    )
  })
  act(() => {
    useAppStore.getState().setBrowserPageCertificateFailure('page-a', certificateFailure())
    reportClientHostedGuestMetadata({
      webContentsId: 42,
      kind: 'failure',
      loading: false,
      hasCertificateFailure: true,
      loadError: { code: -202, description: 'ERR_CERT_AUTHORITY_INVALID', validatedUrl: FAILED_URL }
    })
  })
}

function storedPage(): BrowserPage {
  const page = (useAppStore.getState().browserPagesByWorkspace['workspace-a'] ?? [])[0]
  if (!page) {
    throw new Error('seeded page missing from the store')
  }
  return page
}

function seedStore(): void {
  const page: BrowserPage = {
    id: 'page-a',
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: FAILED_URL,
    title: 'Selfsigned',
    loading: false,
    faviconUrl: null,
    canGoBack: true,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
  const workspace: BrowserWorkspace = {
    id: 'workspace-a',
    worktreeId: 'worktree-a',
    activePageId: 'page-a',
    pageIds: ['page-a'],
    url: page.url,
    title: page.title,
    loading: false,
    faviconUrl: null,
    canGoBack: true,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
  useAppStore.setState({
    browserPagesByWorkspace: { 'workspace-a': [page] },
    browserTabsByWorktree: { 'worktree-a': [workspace] },
    browserCertificateFailuresByPageId: {},
    unifiedTabsByWorktree: {}
  })
}

function certificateFailure(): BrowserCertificateFailure {
  return {
    browserPageId: 'page-a',
    challengeId: 'challenge-1',
    origin: 'https://selfsigned.internal',
    error: 'ERR_CERT_AUTHORITY_INVALID',
    errorCode: -202,
    canProceed: true
  } as BrowserCertificateFailure
}

function createWebview(): Electron.WebviewTag & { getURL: ReturnType<typeof vi.fn> } {
  const element = document.createElement('webview') as Electron.WebviewTag & {
    getURL: ReturnType<typeof vi.fn>
  }
  Object.assign(element, {
    getURL: vi.fn(() => FAILED_URL),
    getTitle: vi.fn(() => 'Selfsigned'),
    isLoading: vi.fn(() => false),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => false),
    getWebContentsId: vi.fn(() => 42),
    getZoomLevel: vi.fn(() => 0),
    setZoomLevel: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    loadURL: vi.fn(async () => {}),
    executeJavaScript: vi.fn(async () => undefined),
    send: vi.fn(),
    style: element.style
  })
  return element
}

function submitUrl(url: string): void {
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: url } })
  const form = input.closest('form')
  if (!form) {
    throw new Error('Address input has no submission form')
  }
  fireEvent.submit(form)
}
