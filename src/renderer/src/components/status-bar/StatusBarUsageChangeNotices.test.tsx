// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { StatusBarUsageChangeNotices } from './StatusBarUsageChangeNotices'

const state = {
  persistedUIReady: true,
  statusBarCompactChangeNoticeDismissed: false,
  dismissStatusBarCompactChangeNotice: vi.fn(),
  statusBarUsageMode: 'compact',
  statusBarVisible: true,
  activeModal: 'none',
  usagePercentageDisplayChangeNoticeDismissed: true,
  dismissUsagePercentageDisplayChangeNotice: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (store: typeof state) => unknown) => selector(state)
}))

describe('status bar usage change notices', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 24,
      y: 700,
      top: 700,
      left: 24,
      bottom: 724,
      right: 200,
      width: 176,
      height: 24,
      toJSON: () => ({})
    })
    Object.assign(state, {
      persistedUIReady: true,
      statusBarCompactChangeNoticeDismissed: false,
      statusBarUsageMode: 'compact',
      statusBarVisible: true,
      activeModal: 'none',
      usagePercentageDisplayChangeNoticeDismissed: true
    })
    state.dismissStatusBarCompactChangeNotice.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function render(
    hasVisibleUsageMeters = true,
    children: ReactNode = <button>Usage</button>
  ): void {
    act(() => {
      root.render(
        <StatusBarUsageChangeNotices hasVisibleUsageMeters={hasVisibleUsageMeters}>
          {children}
        </StatusBarUsageChangeNotices>
      )
    })
  }

  function settle(): void {
    act(() => vi.advanceTimersByTime(1_800))
  }

  it('shows an anchored card after the delay without taking keyboard focus', () => {
    render()
    container.querySelector('button')?.focus()
    const focused = document.activeElement
    expect(document.querySelector('[role="status"]')).toBeNull()
    settle()

    const card = document.querySelector('[role="status"]')
    expect(card?.parentElement).toBe(document.body)
    expect(card?.textContent).toContain('Usage display is now compact')
    expect(card?.textContent).toContain('Choose Detailed in the Usage menu')
    expect(card?.querySelector('[data-slot="badge"]')?.textContent).toBe('Detailed')
    expect(card?.textContent).toContain('Got it')
    expect(document.activeElement).toBe(focused)
  })

  it.each([
    { persistedUIReady: false },
    { statusBarCompactChangeNoticeDismissed: true },
    { statusBarUsageMode: 'verbose' },
    { statusBarVisible: false },
    { activeModal: 'settings' }
  ])('keeps the card hidden for %o', (updates) => {
    Object.assign(state, updates)
    render()
    settle()
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('waits for usage meters to become visible', () => {
    render(false)
    settle()
    expect(document.querySelector('[role="status"]')).toBeNull()
    render(true)
    settle()
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Usage display is now compact'
    )
  })

  it.each(['Got it', 'Dismiss', 'Escape'])('dismisses with %s', (control) => {
    render()
    settle()
    const trigger = container.querySelector('button')
    trigger?.focus()
    act(() => {
      if (control === 'Escape') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      } else {
        const button = Array.from(document.querySelectorAll('[role="status"] button')).find(
          (node) => node.textContent === control || node.getAttribute('aria-label') === control
        )
        expect(button).toBeTruthy()
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }
    })
    expect(state.dismissStatusBarCompactChangeNotice).toHaveBeenCalledTimes(1)
    state.statusBarCompactChangeNoticeDismissed = true
    render()
    settle()
    expect(document.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('button')).toBe(trigger)
    expect(document.activeElement).toBe(trigger)
  })

  it.each(['verbose', 'compact'])('preserves the open menu and focus when choosing %s', (mode) => {
    const menu = (
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger asChild>
          <button>Usage</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <button
            onClick={() => {
              state.statusBarUsageMode = mode
              state.statusBarCompactChangeNoticeDismissed = true
            }}
          >
            Choose mode
          </button>
        </DropdownMenuContent>
      </DropdownMenu>
    )
    render(true, menu)
    settle()
    const trigger = container.querySelector('button')
    const content = document.querySelector('[role="menu"]')
    const selector = content?.querySelector('button')
    expect(selector).toBeTruthy()
    selector?.focus()
    act(() => selector?.click())
    render(true, menu)

    expect(document.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('button')).toBe(trigger)
    expect(document.querySelector('[role="menu"]')).toBe(content)
    expect(document.activeElement).toBe(selector)
  })

  it('does not stack the older percentage callout with the Compact notice', () => {
    state.usagePercentageDisplayChangeNoticeDismissed = false
    render()
    settle()
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('Usage now shows % used')
  })

  it.each([{ statusBarCompactChangeNoticeDismissed: true }, { statusBarUsageMode: 'verbose' }])(
    'restarts the percentage notice delay after %o without remounting the menu',
    (updates) => {
      state.usagePercentageDisplayChangeNoticeDismissed = false
      const menu = (
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger asChild>
            <button>Usage</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <button>Choose mode</button>
          </DropdownMenuContent>
        </DropdownMenu>
      )
      render(true, menu)
      settle()
      const trigger = container.querySelector('button')
      const content = document.querySelector('[role="menu"]')
      const selector = content?.querySelector('button')
      expect(selector).toBeTruthy()
      selector?.focus()

      Object.assign(state, updates)
      render(true, menu)
      expect(document.querySelector('[role="status"]')).toBeNull()
      act(() => vi.advanceTimersByTime(1_799))
      render(true, menu)
      expect(document.querySelector('[role="status"]')).toBeNull()
      act(() => vi.advanceTimersByTime(1))
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        'Usage now shows % used'
      )
      expect(container.querySelector('button')).toBe(trigger)
      expect(document.querySelector('[role="menu"]')).toBe(content)
      expect(document.activeElement).toBe(selector)
    }
  )

  it('cancels the pending Compact timer when switching to the percentage notice', () => {
    state.usagePercentageDisplayChangeNoticeDismissed = false
    render()
    act(() => vi.advanceTimersByTime(900))
    state.statusBarUsageMode = 'verbose'
    render()
    act(() => vi.advanceTimersByTime(900))
    expect(document.querySelector('[role="status"]')).toBeNull()
    act(() => vi.advanceTimersByTime(900))
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Usage now shows % used'
    )
  })
})
