// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { createRef, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { getDefaultSettings } from '../../../../shared/constants'
import { useBrowserExtensionsTour } from './use-browser-extensions-tour'
import { ContextualTourOverlay } from '../contextual-tours/ContextualTourOverlay'
import { BrowserToolbarMenuDropdown } from './assemble-chrome/browser-toolbar-menu-dropdown'
import { installWebPreloadApi } from '@/web/web-preload-api'

const telemetry = vi.hoisted(() => ({ action: vi.fn(), storeOpened: vi.fn() }))
vi.mock('@/diagnostics/telemetry/browser-extensions-telemetry', () => ({
  trackBrowserExtensionsBannerAction: telemetry.action,
  trackBrowserExtensionsWebStoreOpened: telemetry.storeOpened
}))

const requestContextualTour = useAppStore.getState().requestContextualTour
const openBrowserProfileTab = useAppStore.getState().openBrowserProfileTabInActiveWorkspace
const originalApi = window.api
const webClientWindow: Window & { __ORCA_WEB_CLIENT__?: boolean } = window
const originalWebClient = webClientWindow.__ORCA_WEB_CLIENT__

beforeEach(() => {
  telemetry.action.mockClear()
  telemetry.storeOpened.mockClear()
  installWebPreloadApi()
  delete webClientWindow.__ORCA_WEB_CLIENT__
  vi.spyOn(window.api.ui, 'set').mockResolvedValue(undefined)
  vi.useFakeTimers()
  useAppStore.setState({
    requestContextualTour,
    openBrowserProfileTabInActiveWorkspace: openBrowserProfileTab,
    persistedUIReady: true,
    settings: { ...getDefaultSettings(''), browserExtensionsEnabled: true },
    activeContextualTourId: null,
    activeModal: 'none',
    contextualToursSeenIds: [],
    contextualToursStartedThisSession: [],
    contextualToursOnboardingVisible: false,
    contextualToursAutoEligible: false,
    contextualToursBlockingSurfaceVisible: false,
    featureInteractions: { browser: { firstInteractedAt: 1, interactionCount: 1 } }
  })
  const target = document.createElement('button')
  target.setAttribute('data-contextual-tour-target', 'browser-extensions-control')
  target.getBoundingClientRect = () => new DOMRect(10, 10, 24, 24)
  document.body.appendChild(target)
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.api = originalApi
  if (originalWebClient === undefined) {
    delete webClientWindow.__ORCA_WEB_CLIENT__
  } else {
    webClientWindow.__ORCA_WEB_CLIENT__ = originalWebClient
  }
})

// Main answers which banner applies before the announcement is requested.
async function settleAssignment(ms = 250): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(0))
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}

function DiscoveryGuide() {
  useBrowserExtensionsTour(true, true)
  return <ContextualTourOverlay />
}

it('honors an earlier guide, remembers a displayed announcement after interruption, and blocks another guide', async () => {
  useAppStore.setState({
    contextualToursAutoEligible: true,
    contextualToursSeenIds: ['browser'],
    contextualToursStartedThisSession: ['tasks']
  })
  render(<DiscoveryGuide />)
  await act(async () => vi.advanceTimersByTimeAsync(50))
  expect(useAppStore.getState().activeContextualTourId).toBeNull()

  act(() => useAppStore.setState({ contextualToursStartedThisSession: [] }))
  await settleAssignment(50)
  expect(useAppStore.getState().contextualToursSeenIds).toContain('browser-extensions')

  await act(async () => {
    useAppStore.setState({ contextualToursBlockingSurfaceVisible: true })
    await vi.advanceTimersByTimeAsync(50)
  })
  await act(async () => {
    useAppStore.setState({ contextualToursBlockingSurfaceVisible: false })
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(useAppStore.getState().activeContextualTourId).toBeNull()

  const taskTarget = document.createElement('button')
  taskTarget.setAttribute('data-contextual-tour-target', 'tasks-source-filters')
  taskTarget.getBoundingClientRect = () => new DOMRect(10, 10, 24, 24)
  document.body.appendChild(taskTarget)
  act(() => useAppStore.getState().requestContextualTour('tasks', 'tasks_open'))
  expect(useAppStore.getState().activeContextualTourId).toBeNull()
})

function menuProps(
  profileId: string,
  extensionDiscoveryTarget: boolean
): ComponentProps<typeof BrowserToolbarMenuDropdown> {
  return {
    browserPageId: profileId,
    extensionDiscoveryTarget,
    menuOpen: false,
    onMenuOpenChange: () => {},
    profile: {
      browserPageId: profileId,
      effectiveProfileId: profileId,
      allProfiles: [],
      onSwitchProfile: () => {},
      onNewProfile: () => {},
      detectedBrowsers: [],
      onFetchDetectedBrowsers: () => {},
      browserSessionImportState: null,
      onImportFromBrowser: () => {},
      onImportFromFile: () => {},
      forceOpen: false
    },
    pageActions: {
      onFind: () => {},
      onHardReload: () => {},
      onOpenDevTools: () => {},
      onOpenExternal: null
    },
    extensionsSub: <span />,
    viewportPresetId: null,
    onApplyViewportPreset: () => {},
    siteDisplay: null,
    onZoomPage: () => {},
    onSetSiteColorScheme: () => {},
    overflow: {
      triggerRef: createRef(),
      deferUntilClose: (action) => action(),
      onMenuCloseAutoFocus: () => {}
    }
  }
}

it('opens the store in the focused split profile when both browser menus are visible', async () => {
  document.body.replaceChildren()
  const open = vi.fn(async () => true)
  useAppStore.setState({ openBrowserProfileTabInActiveWorkspace: open })
  const view = render(
    <>
      <BrowserToolbarMenuDropdown {...menuProps('profile-a', false)} />
      <BrowserToolbarMenuDropdown {...menuProps('profile-b', true)} />
      <ContextualTourOverlay />
    </>
  )
  view.container.querySelectorAll('[data-browser-profile-id]').forEach((target) => {
    target.getBoundingClientRect = () => new DOMRect(10, 10, 24, 24)
  })
  await act(async () => {
    useAppStore
      .getState()
      .requestContextualTour('browser-extensions', 'browser_extensions_visible', false, {
        force: true
      })
    await vi.advanceTimersByTimeAsync(50)
  })
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Open Web Store' })))
  expect(open).toHaveBeenCalledWith('https://chromewebstore.google.com/', 'profile-b')
})

describe('useBrowserExtensionsTour readiness and blocker recovery', () => {
  it('starts when the active toolbar becomes ready after a long delay', async () => {
    document.body.replaceChildren()
    const request = vi.spyOn(useAppStore.getState(), 'requestContextualTour')
    const { rerender } = renderHook(
      ({ toolbarReady }) => useBrowserExtensionsTour(true, toolbarReady),
      {
        initialProps: { toolbarReady: false }
      }
    )
    act(() => vi.advanceTimersByTime(60_000))
    expect(request).not.toHaveBeenCalled()

    const target = document.createElement('button')
    target.setAttribute('data-contextual-tour-target', 'browser-extensions-control')
    target.getBoundingClientRect = () => new DOMRect(10, 10, 24, 24)
    document.body.appendChild(target)
    rerender({ toolbarReady: true })
    await settleAssignment()

    expect(useAppStore.getState().activeContextualTourId).toBe('browser-extensions')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['modal', 'blocking-surface'] as const)(
    'starts after a long-lived %s closes without remounting the browser',
    async (blocker) => {
      const setBlocked = (blocked: boolean): void => {
        useAppStore.setState(
          blocker === 'modal'
            ? { activeModal: blocked ? 'add-repo' : 'none' }
            : { contextualToursBlockingSurfaceVisible: blocked }
        )
      }
      setBlocked(true)
      const request = vi.spyOn(useAppStore.getState(), 'requestContextualTour')
      renderHook(() => useBrowserExtensionsTour(true, true))
      act(() => vi.advanceTimersByTime(60_000))
      expect(request).not.toHaveBeenCalled()
      act(() => setBlocked(false))
      await settleAssignment()
      expect(useAppStore.getState().activeContextualTourId).toBe('browser-extensions')
      expect(request).toHaveBeenCalledTimes(1)
    }
  )

  it('cancels pending readiness retries and blocker recovery after the browser is hidden', async () => {
    document.body.replaceChildren()
    const request = vi.spyOn(useAppStore.getState(), 'requestContextualTour')
    const { rerender } = renderHook(({ enabled }) => useBrowserExtensionsTour(enabled, true), {
      initialProps: { enabled: true }
    })
    await settleAssignment(0)
    expect(request).toHaveBeenCalledTimes(1)
    rerender({ enabled: false })
    act(() => useAppStore.setState({ contextualToursBlockingSurfaceVisible: true }))
    act(() => vi.advanceTimersByTime(60_000))
    act(() => useAppStore.setState({ contextualToursBlockingSurfaceVisible: false }))
    act(() => vi.advanceTimersByTime(60_000))
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('useBrowserExtensionsTour banner assignment', () => {
  type Reply = Awaited<ReturnType<typeof window.api.telemetryAssignBrowserExtensionsBanner>>

  function answerWith(reply: Reply) {
    const assign = vi.fn(async () => reply)
    window.api.telemetryAssignBrowserExtensionsBanner = assign
    return assign
  }

  function saveBanner(banner: 'none' | 'colored_everyday', reported: boolean): void {
    const settings = useAppStore.getState().settings!
    useAppStore.setState({
      settings: {
        ...settings,
        telemetry: {
          optedIn: true,
          installId: 'install-1',
          existedBeforeTelemetryRelease: false,
          browserExtensionsBanner: { banner, assignedAt: 1, hadExtensions: false, reported }
        }
      }
    })
  }

  it('shows the banner when main says no saved banner applies', async () => {
    const assign = answerWith({ status: 'not_enrolled' })
    renderHook(() => useBrowserExtensionsTour(true, true))
    await settleAssignment()
    expect(assign).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeContextualTourId).toBe('browser-extensions')
  })

  it.each(['deferred', 'not_ready'] as const)(
    'stays hidden when main answers %s',
    async (status) => {
      answerWith({ status })
      renderHook(() => useBrowserExtensionsTour(true, true))
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(useAppStore.getState().activeContextualTourId).toBeNull()
    }
  )

  it('waits for the saved banner instead of acting on the reply', async () => {
    answerWith({ status: 'active', banner: 'colored_everyday' })
    renderHook(() => useBrowserExtensionsTour(true, true))
    await settleAssignment()
    expect(useAppStore.getState().activeContextualTourId).toBeNull()

    act(() => saveBanner('colored_everyday', true))
    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(useAppStore.getState().activeContextualTourId).toBe('browser-extensions')
  })

  it('never shows or asks again for an install saved without a banner', async () => {
    const assign = answerWith({ status: 'not_enrolled' })
    saveBanner('none', true)
    renderHook(() => useBrowserExtensionsTour(true, true))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(assign).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeContextualTourId).toBeNull()
  })

  it('does not follow a saved banner that main has not confirmed', async () => {
    const assign = answerWith({ status: 'deferred' })
    saveBanner('colored_everyday', false)
    renderHook(() => useBrowserExtensionsTour(true, true))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(assign).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeContextualTourId).toBeNull()
  })

  it('shows the saved look and reports a Web Store open from it', async () => {
    answerWith({ status: 'active', banner: 'colored_everyday' })
    saveBanner('colored_everyday', true)
    useAppStore.setState({ openBrowserProfileTabInActiveWorkspace: vi.fn(async () => true) })
    const view = render(<DiscoveryGuide />)
    await settleAssignment()
    expect(view.getByText('Your everyday browser tools, in Orca')).toBeTruthy()

    await act(async () => fireEvent.click(view.getByRole('button', { name: 'Open Web Store' })))
    expect(telemetry.action).toHaveBeenCalledWith('open_web_store')
    expect(telemetry.storeOpened).toHaveBeenCalledWith('banner')
  })

  it('reports closing and choosing Got it', async () => {
    answerWith({ status: 'not_enrolled' })
    const first = render(<DiscoveryGuide />)
    await settleAssignment()
    await act(async () => fireEvent.click(first.getByRole('button', { name: 'Dismiss tour' })))
    expect(telemetry.action).toHaveBeenLastCalledWith('close')
    first.unmount()

    act(() =>
      useAppStore
        .getState()
        .requestContextualTour('browser-extensions', 'browser_extensions_visible', false, {
          force: true
        })
    )
    const second = render(<ContextualTourOverlay />)
    await act(async () => vi.advanceTimersByTimeAsync(50))
    await act(async () => fireEvent.click(second.getByRole('button', { name: 'Got it' })))
    expect(telemetry.action).toHaveBeenLastCalledWith('got_it')
    expect(telemetry.storeOpened).not.toHaveBeenCalled()
  })

  it('does not show once a dialog opened while main was answering', async () => {
    let answer: (reply: Reply) => void = () => {}
    window.api.telemetryAssignBrowserExtensionsBanner = () =>
      new Promise((resolve) => (answer = resolve))
    renderHook(() => useBrowserExtensionsTour(true, true))
    act(() => useAppStore.setState({ activeModal: 'add-repo' }))
    await act(async () => {
      answer({ status: 'not_enrolled' })
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(useAppStore.getState().activeContextualTourId).toBeNull()
  })
})
