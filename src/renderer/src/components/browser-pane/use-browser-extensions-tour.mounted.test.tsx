// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { useBrowserExtensionsTour } from './use-browser-extensions-tour'

const requestContextualTour = useAppStore.getState().requestContextualTour

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState({
    requestContextualTour,
    persistedUIReady: true,
    settings: { ...getDefaultSettings(''), experimentalBrowserExtensions: true },
    activeContextualTourId: null,
    activeModal: 'none',
    contextualToursSeenIds: [],
    contextualTourShownThisSession: false,
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
