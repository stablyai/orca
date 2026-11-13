// @vitest-environment happy-dom
import {
  annotateBrowserPageHandles,
  markHydratedBrowserPageHandles
} from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import { act, cleanup, render as renderWithProviders, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RecoveryWindow from './restored-client-hosted-recovery-window'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'

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

vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))

vi.mock('./restored-client-hosted-recovery-window', async (importOriginal) => {
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
})
vi.mock('./navigate/browser-page-initialization-action', () => ({
  routeBrowserPageInitializationAction: mocks.initializationAction
}))

vi.mock('./assemble-chrome/BrowserAddressBar', () => ({
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
import { useAppStore } from '@/store'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import { requestBrowserFocus } from './host-guest/browser-focus'
import {
  installClientHostedPaneApi,
  paneChannel,
  reportClientHostedGuestMetadata
} from './client-hosted-browser-pane-test-rig'
import {
  captureBrowserInitializationDelivery,
  installBrowserInitializationPresentationLifetime,
  recordBrowserInitializationReceipt
} from '@/runtime/web-session-tabs-sync/browser-initialization-presentation'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { nextReceivedSessionTabsFrame } from '@/runtime/web-session-tabs-sync/state'
import { BrowserHostLeaseRegistry } from '../../../../main/runtime/browser-host/leases/browser-host-lease-registry'
import { RuntimeBrowserPageRegistry } from '../../../../main/runtime/browser/client-pages/runtime-browser-page-registry'
import { recoverUnavailableRuntimeBrowserClientPages } from '../../../../main/runtime/browser/client-pages/runtime-browser-client-page-recovery'
import { buildRuntimeClientBrowserTabs } from '../../../../main/runtime/session-lifecycle/projection/build-runtime-client-browser-tabs'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from '../../../../main/runtime/browser/client-pages/client-hosted-browser-page-persistence'
import { BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
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

  it.each([false, true])(
    'revokes a projected held page on actual transport loss and waits for a fresh page before attaching (null placement %s)',
    async (nullPlacement) => {
      const diagnostics = paneChannel<{
        environmentId: string
        transportGeneration: number
        diagnostics: RemoteRuntimeSharedConnectionDiagnostics
      }>()
      installClientHostedPaneApi({
        runtimeEnvironments: { onSharedControlDiagnostics: diagnostics.subscribe }
      })
      useAppStore.setState({
        browserTabsByWorktree: {},
        browserPagesByWorkspace: {},
        remoteBrowserPageHandlesByPageId: markHydratedBrowserPageHandles({}),
        unifiedTabsByWorktree: {},
        groupsByWorktree: {},
        layoutByWorktree: {},
        runtimeStatusByEnvironmentId: new Map()
      })
      const stopLifetime = installBrowserInitializationPresentationLifetime()
      const authority = new BrowserHostLeaseRegistry({
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a'
      })
      const host = authority.attach({
        browserHostClientId: 'host-a',
        pairedDeviceId: 'device-a',
        connectionId: 'connection-a',
        hostCapabilities: ['webview', 'automation', BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY],
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        pageReconciliationProtocolVersion: 1,
        pageInventory: []
      })
      const pages = new RuntimeBrowserPageRegistry()
      pages.publishClientPage({
        browserPageId: 'page-a',
        workspaceId: 'worktree-a',
        browserProfileId: 'default',
        executionHostKey: 'old-key',
        pairedDeviceId: 'device-a',
        placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
        url: 'https://example.internal/s-final',
        loading: false,
        active: true
      })
      const route = Promise.withResolvers<{ status: 'workspace-gone' }>()
      await recoverUnavailableRuntimeBrowserClientPages({
        authority,
        pages,
        lease: host.lease,
        notifyWorkspace: () => {},
        resolveExecutionHostKey: () => route.promise
      })
      const frame = (): RuntimeMobileSessionTabsResult => ({
        worktree: 'worktree-a',
        publicationEpoch: 'epoch-a',
        snapshotVersion: 1,
        activeGroupId: 'group-a',
        activeTabId: 'page-a',
        activeTabType: 'browser',
        tabs: buildRuntimeClientBrowserTabs(pages.listPages(), authority)
      })
      const apply = (snapshot: RuntimeMobileSessionTabsResult) => {
        recordBrowserInitializationReceipt(
          'environment-a',
          snapshot,
          nextReceivedSessionTabsFrame()
        )
        act(() =>
          useAppStore.setState((state) =>
            applyWebSessionTabsSnapshot(state, snapshot, 'environment-a')
          )
        )
      }
      const emit = (state: 'closed' | 'reconnecting' | 'ready', generation = 1) =>
        act(() =>
          diagnostics.emit({
            environmentId: 'environment-a',
            transportGeneration: generation,
            diagnostics: {
              state,
              pendingRequestCount: 0,
              subscriptionCount: 1,
              reconnectAttempt: 0,
              lastConnectedAt: 1,
              lastClose: null,
              lastError: null
            }
          })
        )
      const cached = frame()
      apply(cached)
      function CurrentPane() {
        const current = useAppStore((state) => state.browserPagesByWorkspace['page-a']?.[0])
        const handle = useAppStore((state) => state.remoteBrowserPageHandlesByPageId['page-a'])
        return current ? (
          <ClientHostedBrowserPagePane
            browserTab={current}
            workspaceId="page-a"
            chromeShortcutScope="focused"
            runtimeEnvironmentId="environment-a"
            worktreeId="worktree-a"
            placement={
              nullPlacement ? null : handle?.placement?.kind === 'client' ? handle.placement : null
            }
            isActive
            onUpdatePageState={(id, patch) =>
              useAppStore.getState().updateBrowserPageState(id, patch)
            }
            onSetUrl={vi.fn()}
          />
        ) : null
      }
      const view = renderWithProviders(<CurrentPane />, { wrapper: TooltipProvider })
      try {
        emit('ready')
        expect(screen.getByRole('button', { name: 'Stop' })).not.toBeNull()
        expect(screen.queryByText('Client-hosted browser unavailable')).toBeNull()
        expect(mocks.attach).not.toHaveBeenCalled()
        const delayed = frame()
        recordBrowserInitializationReceipt('environment-a', delayed, nextReceivedSessionTabsFrame())
        emit('closed')
        expect(screen.getByText('Client-hosted browser unavailable')).not.toBeNull()
        expect(screen.queryByText(/Can't reach/)).toBeNull()
        expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
        expect(screen.getByLabelText<HTMLInputElement>('Address').value).toBe(
          'https://example.internal/s-final'
        )
        const afterLoss = useAppStore.getState()
        emit('reconnecting')
        expect(useAppStore.getState()).toBe(afterLoss)
        emit('ready', 2)
        apply(cached)
        apply(delayed)
        expect(screen.getByText('Client-hosted browser unavailable')).not.toBeNull()
        apply(frame())
        expect(screen.queryByText('Client-hosted browser unavailable')).toBeNull()
        expect(screen.getByRole('button', { name: 'Stop' })).not.toBeNull()
        emit('closed', 1)
        expect(screen.queryByText('Client-hosted browser unavailable')).toBeNull()
        // Actual guest metadata supplies current document failure after initialization omission.
        const { webview } = createWebview()
        mocks.attach.mockReturnValue(retainedAttachment(webview))
        reportClientHostedGuestMetadata({
          webContentsId: 7,
          url: 'https://example.internal/s-final',
          errorPage: true,
          loadError: {
            code: -105,
            description: 'Name resolution failed',
            validatedUrl: 'https://example.internal/s-final'
          }
        })
        const committed = frame()
        committed.snapshotVersion = 2
        committed.tabs = committed.tabs.map((tab) =>
          tab.type === 'browser'
            ? { ...tab, initializationState: undefined, placement: PLACEMENT, loading: false }
            : tab
        )
        if (!nullPlacement) {
          apply(committed)
          expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2)
          expect(useAppStore.getState().browserPagesByWorkspace['page-a'][0].loadError?.code).toBe(
            -105
          )
          apply({ ...committed, snapshotVersion: 3 })
          expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2)
          expect(useAppStore.getState().browserPagesByWorkspace['page-a'][0].loadError?.code).toBe(
            -105
          )
        }
      } finally {
        view.unmount()
        stopLifetime()
        authority.cancelClientPageInitialization('page-a', RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT)
        route.resolve({ status: 'workspace-gone' })
        host.release()
      }
    }
  )

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
    act(() =>
      reportClientHostedGuestMetadata({ webContentsId: 7, kind: 'stop', loadError, loading: false })
    )
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
    // Reload on chrome-error:// refreshes the error page; Retry must navigate to the attempted URL.
    act(() => screen.getByText('Retry').click())
    expect(webview.reload).not.toHaveBeenCalled()
    expect(webview.src).toBe(normalizeBrowserNavigationUrl(loadError.validatedUrl))
  })

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

  it('gives the guest focus back after the palette hands the address bar a turn', () => {
    const { webview, focus, setUrl } = createWebview()
    // Why: the attach is mocked, so place the guest where the real attach would put it.
    document.body.appendChild(webview)
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

    // Cmd+J dismissal reclaims the bar repeatedly; this pane has no local load handlers to clear the latch.
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
    // Pin macOS so the Cmd+L test does not depend on the runner platform.
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

    // A guest owns separate WebContents focus until explicitly blurred, even after an input is focused.
    expect(blur).toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByLabelText('Address'))
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
