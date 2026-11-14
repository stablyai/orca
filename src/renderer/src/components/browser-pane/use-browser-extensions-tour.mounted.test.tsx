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

const requestContextualTour = useAppStore.getState().requestContextualTour
const openBrowserProfileTab = useAppStore.getState().openBrowserProfileTabInActiveWorkspace
const originalApi = window.api
const webClientWindow: Window & { __ORCA_WEB_CLIENT__?: boolean } = window
const originalWebClient = webClientWindow.__ORCA_WEB_CLIENT__

beforeEach(() => {
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

  await act(async () => {
    useAppStore.setState({ contextualToursStartedThisSession: [] })
    await vi.advanceTimersByTimeAsync(50)
  })
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
  it('starts when the active toolbar becomes ready after a long delay', () => {
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
    act(() => vi.advanceTimersByTime(250))

    expect(useAppStore.getState().activeContextualTourId).toBe('browser-extensions')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['modal', 'blocking-surface'] as const)(
    'starts after a long-lived %s closes without remounting the browser',
    (blocker) => {
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
      act(() => vi.advanceTimersByTime(250))
      expect(useAppStore.getState().activeContextualTourId).toBe('browser-extensions')
      expect(request).toHaveBeenCalledTimes(1)
    }
  )

  it('cancels pending readiness retries and blocker recovery after the browser is hidden', () => {
    document.body.replaceChildren()
    const request = vi.spyOn(useAppStore.getState(), 'requestContextualTour')
    const { rerender } = renderHook(({ enabled }) => useBrowserExtensionsTour(enabled, true), {
      initialProps: { enabled: true }
    })
    act(() => vi.advanceTimersByTime(0))
    expect(request).toHaveBeenCalledTimes(1)
    rerender({ enabled: false })
    act(() => useAppStore.setState({ contextualToursBlockingSurfaceVisible: true }))
    act(() => vi.advanceTimersByTime(60_000))
    act(() => useAppStore.setState({ contextualToursBlockingSurfaceVisible: false }))
    act(() => vi.advanceTimersByTime(60_000))
    expect(request).toHaveBeenCalledTimes(1)
  })
})
