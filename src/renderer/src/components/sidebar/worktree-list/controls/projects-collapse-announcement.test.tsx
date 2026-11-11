// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

import { useProjectsCollapseShortcut } from './use-projects-collapse-shortcut'

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
