// @vitest-environment happy-dom

import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useProjectsCollapseAllAnnouncement } from './use-projects-collapse-all-announcement'
import { useProjectsCollapseShortcut } from './use-projects-collapse-shortcut'
import { hasContextualTourTarget } from '@/components/contextual-tours/contextual-tour-gate'
import { getContextualTour } from '../../../../../../shared/contextual-tours'

const initialState = useAppStore.getInitialState()
let target: HTMLElement
let guestShortcut: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState(
    {
      ...initialState,
      persistedUIReady: true,
      contextualToursAutoEligible: false
    },
    true
  )
  Object.assign(window, {
    api: {
      ui: {
        set: () => Promise.resolve(),
        onToggleProjectsCollapse: (callback: () => void) => {
          guestShortcut = callback
          return () => {
            guestShortcut = undefined
          }
        }
      }
    }
  })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
  target = document.createElement('div')
  target.setAttribute('data-contextual-tour-target', 'projects-collapse-all')
  target.innerHTML = '<span data-projects-collapse-toggle><button>Toggle</button></span>'
  target.getBoundingClientRect = () => new DOMRect(100, 100, 150, 24)
  document.body.append(target)
})

afterEach(() => {
  cleanup()
  target.remove()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function settle(ms = 100): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

it('waits for a manual project collapse, including after StrictMode remounts', async () => {
  const { result } = renderHook(() => useProjectsCollapseAllAnnouncement(true), {
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
  })
  await settle()
  expect(useAppStore.getState().activeContextualTourId).toBeNull()
  act(() => {
    useAppStore.getState().toggleCollapsedGroup('repo:one')
    result.current('repo:one')
  })
  expect(useAppStore.getState().activeContextualTourId).toBe('projects-collapse-all')
})

it('waits for another related action if a modal blocks the tip', async () => {
  useAppStore.setState({ activeModal: 'add-repo' })
  const { result } = renderHook(() => useProjectsCollapseAllAnnouncement(true))
  act(() => {
    useAppStore.getState().toggleCollapsedGroup('repo:one')
    result.current('repo:one')
  })
  await settle()
  expect(useAppStore.getState().activeContextualTourId).toBeNull()
  act(() => useAppStore.setState({ activeModal: 'none' }))
  await settle()
  expect(useAppStore.getState().activeContextualTourId).toBeNull()
  act(() => {
    useAppStore.getState().toggleCollapsedGroup('repo:two')
    result.current('repo:two')
  })
  expect(useAppStore.getState().activeContextualTourId).toBe('projects-collapse-all')
})

it('suppresses the announcement when its list unmounts', () => {
  const { result, unmount } = renderHook(() => useProjectsCollapseAllAnnouncement(true))
  act(() => {
    useAppStore.getState().toggleCollapsedGroup('repo:one')
    result.current('repo:one')
  })
  unmount()
  expect(useAppStore.getState().activeContextualTourSuppressed).toBe(true)
  target.querySelector('[data-projects-collapse-toggle]')!.remove()
  expect(
    hasContextualTourTarget(getContextualTour('projects-collapse-all').steps[0].targetSelector)
  ).toBe(false)
})

it('includes profiles that originally onboarded into contextual tours', () => {
  useAppStore.setState({ contextualToursAutoEligible: true })
  const { result } = renderHook(() => useProjectsCollapseAllAnnouncement(true))
  act(() => {
    useAppStore.getState().toggleCollapsedGroup('project:one')
    result.current('project:one')
  })
  expect(useAppStore.getState().activeContextualTourId).toBe('projects-collapse-all')
})

it('ignores expanding projects and collapsing other kinds of section', () => {
  const { result } = renderHook(() => useProjectsCollapseAllAnnouncement(true))
  act(() => {
    result.current('repo:one')
    useAppStore.getState().toggleCollapsedGroup('pinned')
    result.current('pinned')
  })
  expect(useAppStore.getState().activeContextualTourId).toBeNull()
})

it('does not repeat a dismissed announcement', () => {
  useAppStore.setState({ contextualToursSeenIds: ['projects-collapse-all'] })
  const { result } = renderHook(() => useProjectsCollapseAllAnnouncement(true))
  act(() => {
    useAppStore.getState().toggleCollapsedGroup('repo:one')
    result.current('repo:one')
  })
  expect(useAppStore.getState().activeContextualTourId).toBeNull()
})

it('skips the announcement when collapse-all has already been used', () => {
  useAppStore.setState({
    featureInteractions: {
      'projects-collapse-all': { firstInteractedAt: 1, interactionCount: 1 }
    }
  })
  const { result } = renderHook(() => useProjectsCollapseAllAnnouncement(true))
  act(() => {
    useAppStore.getState().toggleCollapsedGroup('repo:one')
    result.current('repo:one')
  })
  expect(useAppStore.getState().activeContextualTourId).toBeNull()
})

it('keeps the shortcut usable during its own announcement and respects other dialogs', () => {
  const toggle = vi.fn()
  renderHook(() => useProjectsCollapseShortcut(true, toggle))
  const panel = document.createElement('section')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('data-contextual-tour-panel', 'projects-collapse-all')
  const rects = [new DOMRect(100, 140, 320, 180)]
  panel.getClientRects = () =>
    Object.assign(rects, { item: (index: number) => rects[index] ?? null })
  document.body.append(panel)
  const press = () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'р',
        code: 'KeyH',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )
  press()
  expect(toggle).toHaveBeenCalledOnce()
  toggle.mockClear()
  guestShortcut?.()
  expect(toggle).toHaveBeenCalledOnce()
  panel.removeAttribute('data-contextual-tour-panel')
  toggle.mockClear()
  press()
  guestShortcut?.()
  expect(toggle).not.toHaveBeenCalled()
  panel.remove()
})
