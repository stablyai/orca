// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
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
import { installClientHostedPaneApi } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

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
  mocks.attach.mockReturnValue({
    webview,
    detach: vi.fn(),
    nextMetadataRevision: vi.fn(() => 1)
  })
  seedStore()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/**
 * A worktree switch unmounts the pane subtree while main keeps the guest alive, so the pane
 * remounts over a guest that is still painting whatever it last loaded. These drive the real
 * store both ways, because the wipe being guarded against is the store's own coupling:
 * writing loadError:null also deletes the page's certificate record.
 */
describe('ClientHostedBrowserPagePane failure records across a remount', () => {
  it('keeps the failure and the certificate record when the guest still sits on the failed page', () => {
    const view = render(<StoreDrivenPane />)
    failLoad()
    expect(storedPage().loadError?.validatedUrl).toBe(FAILED_URL)
    expect(screen.getByRole('button', { name: 'Copy Address' })).not.toBeNull()

    act(() => view.unmount())
    render(<StoreDrivenPane />)

    expect(storedPage().loadError?.validatedUrl).toBe(FAILED_URL)
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeDefined()
    expect(screen.getByRole('button', { name: 'Copy Address' })).not.toBeNull()
  })

  it('keeps both records when the guest is parked on the Chromium error page', () => {
    const view = render(<StoreDrivenPane />)
    failLoad()

    act(() => view.unmount())
    // A guest that never left the failed navigation paints chrome-error://chromewebdata/ and
    // reports that as its URL, so the remount meets a URL that matches nothing it recorded.
    webview.getURL.mockReturnValue('chrome-error://chromewebdata/')
    render(<StoreDrivenPane />)

    expect(storedPage().loadError?.validatedUrl).toBe(FAILED_URL)
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeDefined()
    expect(screen.getByRole('button', { name: 'Copy Address' })).not.toBeNull()
  })

  it('clears both records when the guest moved on while the pane was unmounted', () => {
    const view = render(<StoreDrivenPane />)
    failLoad()

    act(() => view.unmount())
    // Nothing observes the guest while the pane is gone, so a navigation that lands in the gap
    // is only ever noticed by the sync the remount runs.
    webview.getURL.mockReturnValue('https://example.internal/recovered')
    render(<StoreDrivenPane />)

    expect(storedPage().loadError).toBeNull()
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
    expect(screen.queryByRole('button', { name: 'Copy Address' })).toBeNull()
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
