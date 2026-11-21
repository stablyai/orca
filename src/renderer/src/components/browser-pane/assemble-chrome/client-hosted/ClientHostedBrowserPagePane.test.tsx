// @vitest-environment happy-dom
import {
  annotateBrowserPageHandles,
  markHydratedBrowserPageHandles
} from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import { act, cleanup, render as renderWithProviders, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RecoveryWindow from '../../host-guest/recovery/restored-client-hosted-recovery-window'
import type { BrowserPage } from '../../../../../../shared/browser/workspaces/browser-workspace-types'

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  publishMetadata: vi.fn(),
  createBrowserTab: vi.fn(async () => true),
  restoredPageUnrecovered: false,
  realRecoveryWindow: false,
  initializationAction: vi.fn(async () => {}),
  addressBar: {
    current: null as {
      value: string
      onNavigate: (value: string) => void
      inputRef: React.RefObject<HTMLInputElement | null>
    } | null
  }
}))

vi.mock('@/runtime/browser/creation/web-runtime-browser-creation', () => ({
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

vi.mock('../../host-guest/client-pages/browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))

vi.mock(
  '../../host-guest/recovery/restored-client-hosted-recovery-window',
  async (importOriginal) => {
    const actual = await importOriginal<typeof RecoveryWindow>()
    return {
      ...actual,
      useRestoredClientHostedRecoveryWindow: (
        input: Parameters<typeof actual.useRestoredClientHostedRecoveryWindow>[0]
      ) => {
        const elapsed = actual.useRestoredClientHostedRecoveryWindow(input)
        return mocks.realRecoveryWindow ? elapsed : mocks.restoredPageUnrecovered
      }
    }
  }
)
vi.mock('../../navigate/browser-page-initialization-action', () => ({
  routeBrowserPageInitializationAction: mocks.initializationAction
}))

vi.mock('../address-bar/BrowserAddressBar', () => ({
  // Keep the shared bar’s own behavior out of this suite; preserve the ref targeted by pane focus rules.
  default: (props: {
    value: string
    onNavigate: (value: string) => void
    inputRef: React.RefObject<HTMLInputElement | null>
  }) => {
    mocks.addressBar.current = props
    return <input aria-label="Address" ref={props.inputRef} value={props.value} readOnly />
  }
}))

import { connectedRuntimeStatus } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { useAppStore } from '@/store/index'
import '../../../../../../shared/browser/navigation/browser-url'
import {
  installClientHostedPaneApi,
  reportClientHostedGuestMetadata
} from './client-hosted-browser-pane-test-rig'
import { captureBrowserInitializationDelivery } from '@/runtime/web-session-tabs-sync/tab-projection/browser-initialization-presentation'
import '@/runtime/web-session-tabs-sync/snapshots/snapshot-api'
import '@/runtime/web-session-tabs-sync/state'
import '../../../../../../main/runtime/browser-host/leases/browser-host-lease-registry'
import '../../../../../../main/runtime/browser/client-pages/runtime-browser-page-registry'
import '../../../../../../main/runtime/browser/client-pages/runtime-browser-client-page-recovery'
import '../../../../../../main/runtime/session-lifecycle/projection/build-runtime-client-browser-tabs'
import '../../../../../../main/runtime/browser/client-pages/client-hosted-browser-page-persistence'
import '../../../../../../shared/browser/client-hosting/browser-client-host-protocol'

import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

function render(ui: React.ReactElement<{ browserTab: BrowserPage }>) {
  const current = ui.props.browserTab
  useAppStore.setState({ browserPagesByWorkspace: { [current.workspaceId]: [current] } })
  return renderWithProviders(ui, { wrapper: TooltipProvider })
}

describe('ClientHostedBrowserPagePane', () => {
  beforeEach(() => {
    useAppStore.setState({ remoteBrowserPageHandlesByPageId: markHydratedBrowserPageHandles({}) })
    mocks.attach.mockReset()
    mocks.restoredPageUnrecovered = false
    mocks.realRecoveryWindow = false
    mocks.initializationAction.mockClear()
    mocks.publishMetadata.mockReset().mockResolvedValue({ status: 'published', accepted: true })
    // Download, popup and permission notices subscribe on mount; each has its own suite.
    installClientHostedPaneApi({ browser: { publishClientPageMetadata: mocks.publishMetadata } })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it.each([null, { ...PLACEMENT, pageHostGeneration: 0 }])(
    'keeps owned recovery usable beyond the legacy absence window with placement %j',
    async (placement) => {
      vi.useFakeTimers()
      mocks.realRecoveryWindow = true
      useAppStore.setState({
        remoteBrowserPageHandlesByPageId: annotateBrowserPageHandles(
          {
            'page-a': {
              environmentId: 'environment-a',
              remotePageId: 'page-a',
              restoredFromSession: true,
              initializationPresentation: {
                disposition: 'pending',
                receivedFrame: 1,
                delivery: captureBrowserInitializationDelivery('environment-a')
              },
              placement: placement ?? { ...PLACEMENT, pageHostGeneration: 0 }
            }
          },
          ['page-a']
        ),
        runtimeStatusByEnvironmentId: new Map([
          ['environment-a', connectedRuntimeStatus('runtime-a', 1)]
        ])
      })
      const pending = {
        ...page(),
        url: 'https://example.internal/saved',
        loading: true
      }
      const pane = (browserTab: BrowserPage, currentPlacement = placement) => (
        <ClientHostedBrowserPagePane
          browserTab={browserTab}
          workspaceId="workspace-a"
          chromeShortcutScope="focused"
          runtimeEnvironmentId="environment-a"
          worktreeId="worktree-a"
          placement={currentPlacement}
          isActive
          onUpdatePageState={vi.fn()}
          onSetUrl={vi.fn()}
        />
      )
      const view = render(pane(pending))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(screen.queryByText('Reopen')).toBeNull()
      expect(screen.getByLabelText<HTMLInputElement>('Address').value).toBe(
        'https://example.internal/saved'
      )
      expect(mocks.attach).not.toHaveBeenCalled()
      act(() => screen.getByRole('button', { name: 'Stop' }).click())
      // The restored sentinel handle supplies the exact pending owner even before placement arrives.
      expect(mocks.initializationAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: { type: 'stop' } })
      )
      act(() =>
        useAppStore.setState((s) => ({
          remoteBrowserPageHandlesByPageId: annotateBrowserPageHandles(
            {
              ...s.remoteBrowserPageHandlesByPageId,
              'page-a': {
                ...s.remoteBrowserPageHandlesByPageId['page-a'],
                initializationPresentation: {
                  disposition: 'stopped',
                  receivedFrame: 2,
                  delivery: captureBrowserInitializationDelivery('environment-a')
                }
              }
            },
            ['page-a']
          )
        }))
      )
      const stopped = { ...pending, loading: false }
      view.rerender(pane(stopped))
      expect(screen.queryByText('Reopen')).toBeNull()
      expect(screen.getByRole('button', { name: 'Reload' })).not.toBeNull()
      const { webview } = createWebview()
      mocks.attach.mockReturnValue(retainedAttachment(webview))
      act(() =>
        useAppStore.setState((s) => ({
          remoteBrowserPageHandlesByPageId: annotateBrowserPageHandles(
            {
              ...s.remoteBrowserPageHandlesByPageId,
              'page-a': {
                ...s.remoteBrowserPageHandlesByPageId['page-a'],
                initializationPresentation: undefined
              }
            },
            ['page-a']
          )
        }))
      )
      view.rerender(pane(stopped, PLACEMENT))
      expect(mocks.attach).toHaveBeenCalled()
    }
  )

  it('keeps Find open across subframe settlement and closes it only on a full commit', () => {
    const { webview } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    let openFind = () => {}
    installClientHostedPaneApi({
      ui: {
        onFindInBrowserPage: (_target, listener) => {
          openFind = listener
          return () => {}
        }
      }
    })
    reportClientHostedGuestMetadata({
      webContentsId: 7,
      url: 'https://example.internal/',
      title: 'Example'
    })
    render(
      <ClientHostedBrowserPagePane
        browserTab={{ ...page(), url: 'https://example.internal/' }}
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
    act(() => openFind())
    expect(screen.getByPlaceholderText('Find in page...')).not.toBeNull()
    act(() => reportClientHostedGuestMetadata({ webContentsId: 7, kind: 'stop' }))
    expect(screen.getByPlaceholderText('Find in page...')).not.toBeNull()
    act(() => webview.dispatchEvent(new Event('did-navigate')))
    expect(screen.queryByPlaceholderText('Find in page...')).toBeNull()
  })

  it('restores the committed address after an attempted navigation is stopped', async () => {
    const { webview } = createWebview()
    reportClientHostedGuestMetadata({
      webContentsId: 7,
      url: 'https://example.internal/a',
      title: 'Example'
    })
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    const onSetUrl = vi.fn()
    const onUpdatePageState = vi.fn()
    render(
      <ClientHostedBrowserPagePane
        browserTab={{ ...page(), url: 'https://example.internal/a' }}
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
    act(() => mocks.addressBar.current?.onNavigate('https://example.internal/b'))
    act(() => reportClientHostedGuestMetadata({ webContentsId: 7, kind: 'start', loading: true }))
    expect(screen.getByLabelText<HTMLInputElement>('Address').value).toBe(
      'https://example.internal/b'
    )
    act(() => screen.getByLabelText<HTMLInputElement>('Address').blur())
    onSetUrl.mockClear()
    await act(async () =>
      reportClientHostedGuestMetadata({ webContentsId: 7, kind: 'stop', loading: false })
    )
    expect(screen.getByLabelText<HTMLInputElement>('Address').value).toBe(
      'https://example.internal/a'
    )
    expect(onSetUrl).not.toHaveBeenCalled()
    expect(onUpdatePageState).toHaveBeenCalledWith(
      'page-a',
      expect.objectContaining({ loading: false, loadError: null })
    )
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
  // Why: a real <webview> becomes activeElement when focused; focus code checks for that.
  webview.tabIndex = -1
  const focus = vi.fn(() => HTMLElement.prototype.focus.call(webview))
  const blur = vi.fn(() => HTMLElement.prototype.blur.call(webview))
  Object.assign(webview, {
    // An attached guest has a WebContents id; focus waits for one.
    getWebContentsId: vi.fn(() => 7),
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
  reportClientHostedGuestMetadata({ webContentsId: 7, url, title })
  return {
    webview,
    focus,
    blur,
    setUrl: (nextUrl) => {
      url = nextUrl
      reportClientHostedGuestMetadata({ webContentsId: 7, kind: 'navigation', url })
    },
    setTitle: (nextTitle) => {
      title = nextTitle
      reportClientHostedGuestMetadata({ webContentsId: 7, kind: 'title', title })
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
