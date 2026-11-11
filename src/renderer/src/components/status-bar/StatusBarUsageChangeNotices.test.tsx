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
})
