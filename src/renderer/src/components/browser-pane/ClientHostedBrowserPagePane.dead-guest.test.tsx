// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  recordBreadcrumb: vi.fn()
}))

vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordBreadcrumb
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), message: vi.fn() }
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { installClientHostedPaneApi } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}

/** Verbatim from Electron 43.4.1: main destroyed the guest, the tag still holds its id. */
function invalidGuestInstanceId(): Error {
  return new Error('Invalid guestInstanceId: 7')
}

/** Verbatim from Electron 43.4.1: focus() after the retained tag left the DOM. */
function nullContentWindowFocus(): TypeError {
  return new TypeError("Cannot read properties of null (reading 'focus')")
}

function page(overrides?: Partial<BrowserPage>): BrowserPage {
  return {
    id: 'page-a',
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: 'https://example.internal/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1,
    ...overrides
  }
}

function createGuest(): Electron.WebviewTag & {
  getURL: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
} {
  const webview = document.createElement('webview') as Electron.WebviewTag & {
    getURL: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
  }
  Object.assign(webview, {
    getURL: vi.fn(() => 'https://example.internal/'),
    getTitle: vi.fn(() => 'Example'),
    isLoading: vi.fn(() => false),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    focus: vi.fn(),
    blur: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    loadURL: vi.fn(async () => {})
  })
  mocks.attach.mockReturnValue({
    webview,
    detach: mocks.detach,
    nextMetadataRevision: vi.fn(() => 1)
  })
  return webview
}

function paneElement(
  isActive: boolean,
  options?: { browserTab?: BrowserPage; onUpdatePageState?: (id: string, state: unknown) => void }
): React.JSX.Element {
  return (
    <TooltipProvider>
      <ClientHostedBrowserPagePane
        browserTab={options?.browserTab ?? page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive={isActive}
        onUpdatePageState={options?.onUpdatePageState ?? vi.fn()}
        onSetUrl={vi.fn()}
      />
    </TooltipProvider>
  )
}

let webview: ReturnType<typeof createGuest>

beforeEach(() => {
  mocks.attach.mockReset()
  mocks.detach.mockReset()
  mocks.recordBreadcrumb.mockReset()
  installClientHostedPaneApi()
  webview = createGuest()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('client-hosted browser pane over a dead guest', () => {
  it('degrades to the unavailable notice when the guest was destroyed in main', () => {
    webview.getURL.mockImplementation(() => {
      throw invalidGuestInstanceId()
    })

    expect(() => render(paneElement(true))).not.toThrow()
    expect(screen.getByText('Client-hosted browser unavailable')).toBeTruthy()
    expect(mocks.detach).toHaveBeenCalled()
    expect(mocks.recordBreadcrumb).toHaveBeenCalledWith('browser_client_page_guest_unavailable', {
      browserPageId: 'page-a',
      pageHostGeneration: PLACEMENT.pageHostGeneration,
      reason: 'unreadable',
      tagConnected: false
    })
    // Why: the catch is total, so the swallowed error must stay visible to diagnostics.
    expect(mocks.recordBreadcrumb).toHaveBeenCalledWith('browser_client_page_guest_read_failed', {
      errorName: 'Error',
      errorMessage: 'Invalid guestInstanceId: 7'
    })
  })

  it('stops the spinner it inherited from a page that died mid-load', () => {
    webview.getURL.mockImplementation(() => {
      throw invalidGuestInstanceId()
    })
    const onUpdatePageState = vi.fn()

    render(paneElement(true, { browserTab: page({ loading: true }), onUpdatePageState }))

    expect(onUpdatePageState).toHaveBeenCalledWith('page-a', { loading: false })
  })

  it('flips to the unavailable notice when the guest renderer goes away after attach', () => {
    const onUpdatePageState = vi.fn()
    render(paneElement(true, { browserTab: page({ loading: true }), onUpdatePageState }))
    expect(screen.queryByText('Client-hosted browser unavailable')).toBeNull()
    onUpdatePageState.mockClear()

    // The registry pulls the tag out of the DOM on this event without telling the pane.
    webview.remove()
    act(() => {
      webview.dispatchEvent(new Event('render-process-gone'))
    })

    expect(screen.getByText('Client-hosted browser unavailable')).toBeTruthy()
    expect(mocks.detach).toHaveBeenCalled()
    expect(onUpdatePageState).toHaveBeenCalledWith('page-a', { loading: false })
    expect(mocks.recordBreadcrumb).toHaveBeenCalledWith('browser_client_page_guest_unavailable', {
      browserPageId: 'page-a',
      pageHostGeneration: PLACEMENT.pageHostGeneration,
      reason: 'render-process-gone',
      tagConnected: false
    })
  })

  it('flips to the unavailable notice when main destroys the guest after attach', () => {
    render(paneElement(true))

    act(() => {
      webview.dispatchEvent(new Event('destroyed'))
    })

    expect(screen.getByText('Client-hosted browser unavailable')).toBeTruthy()
    expect(mocks.recordBreadcrumb).toHaveBeenCalledWith(
      'browser_client_page_guest_unavailable',
      expect.objectContaining({ reason: 'destroyed' })
    )
    // The chrome must not keep driving the dead tag: Reload routes to the notice, not a throw.
    webview.reload.mockImplementation(() => {
      throw invalidGuestInstanceId()
    })
    expect(() => act(() => screen.getByRole('button', { name: 'Reload' }).click())).not.toThrow()
    expect(webview.reload).not.toHaveBeenCalled()
  })

  it('does not freeze silently when a navigation event finds the guest gone', () => {
    const onUpdatePageState = vi.fn()
    render(paneElement(true, { onUpdatePageState }))
    onUpdatePageState.mockClear()
    webview.getURL.mockImplementation(() => {
      throw invalidGuestInstanceId()
    })

    act(() => {
      webview.dispatchEvent(new Event('did-navigate'))
    })

    expect(screen.getByText('Client-hosted browser unavailable')).toBeTruthy()
    expect(onUpdatePageState).toHaveBeenCalledWith('page-a', { loading: false })
  })

  it('stops the spinner when the guest dies as a load starts', () => {
    const onUpdatePageState = vi.fn()
    render(paneElement(true, { onUpdatePageState }))
    onUpdatePageState.mockClear()
    webview.getURL.mockImplementation(() => {
      throw invalidGuestInstanceId()
    })

    act(() => {
      webview.dispatchEvent(new Event('did-start-loading'))
    })

    expect(screen.getByText('Client-hosted browser unavailable')).toBeTruthy()
    // did-start-loading writes loading:true first; the loss must be the last word.
    expect(onUpdatePageState.mock.calls.at(-1)).toEqual(['page-a', { loading: false }])
  })

  it('ignores queued load events after guest loss', () => {
    const onUpdatePageState = vi.fn()
    render(paneElement(true, { onUpdatePageState }))
    act(() => webview.dispatchEvent(new Event('destroyed')))
    onUpdatePageState.mockClear()

    act(() => webview.dispatchEvent(new Event('did-start-loading')))

    expect(onUpdatePageState).not.toHaveBeenCalled()
    expect(screen.getByText('Client-hosted browser unavailable')).toBeTruthy()
  })

  it('uses the guarded title snapshot if the guest dies immediately afterward', () => {
    render(paneElement(true))
    webview.getTitle = vi.fn(() => {
      webview.getTitle = vi.fn(() => {
        throw invalidGuestInstanceId()
      })
      return 'Last live title'
    })

    expect(() => act(() => webview.dispatchEvent(new Event('did-navigate')))).not.toThrow()
    expect(webview.getTitle).not.toHaveBeenCalled()
  })

  it('shows unavailability when a load-failure fallback finds the guest gone', () => {
    const onUpdatePageState = vi.fn()
    render(paneElement(true, { onUpdatePageState }))
    webview.getURL.mockImplementation(() => {
      throw invalidGuestInstanceId()
    })

    act(() => webview.dispatchEvent(new Event('did-fail-load')))

    expect(screen.getByText('Client-hosted browser unavailable')).toBeTruthy()
    expect(onUpdatePageState.mock.calls.at(-1)).toEqual(['page-a', { loading: false }])
  })

  it('removes loss listeners when the initial guest read fails', () => {
    const removeListener = vi.spyOn(webview, 'removeEventListener')
    webview.getURL.mockImplementation(() => {
      throw invalidGuestInstanceId()
    })

    render(paneElement(true))

    expect(removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function))
    expect(removeListener).toHaveBeenCalledWith('render-process-gone', expect.any(Function))
  })

  it('stops listening for guest loss once the pane lets go of the tag', () => {
    const onUpdatePageState = vi.fn()
    const view = render(paneElement(true, { onUpdatePageState }))
    view.unmount()
    onUpdatePageState.mockClear()
    mocks.recordBreadcrumb.mockClear()

    webview.dispatchEvent(new Event('destroyed'))

    expect(onUpdatePageState).not.toHaveBeenCalled()
    expect(mocks.recordBreadcrumb).not.toHaveBeenCalled()
  })

  it('survives activation focus after the retained tag left the DOM', () => {
    const view = render(paneElement(false))
    webview.focus = vi.fn(() => {
      throw nullContentWindowFocus()
    })

    expect(() =>
      act(() => {
        view.rerender(paneElement(true))
      })
    ).not.toThrow()
    expect(webview.focus).toHaveBeenCalled()
  })
})
