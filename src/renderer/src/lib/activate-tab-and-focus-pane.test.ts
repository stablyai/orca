import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'
import { activateTabAndFocusPane } from './activate-tab-and-focus-pane'

const setActiveTab = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      setActiveTab
    })
  }
}))

class MockCustomEvent<T = unknown> {
  readonly type: string
  readonly detail: T | undefined

  constructor(type: string, init?: { detail?: T }) {
    this.type = type
    this.detail = init?.detail
  }
}

describe('activateTabAndFocusPane', () => {
  const dispatchEvent = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    setActiveTab.mockClear()
    dispatchEvent.mockClear()
    vi.stubGlobal('window', { dispatchEvent })
    vi.stubGlobal('CustomEvent', MockCustomEvent)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 42)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('dispatches the pane focus event through a timeout fallback when animation frames are suspended', () => {
    activateTabAndFocusPane('tab-1', 'leaf-1', {
      ackPaneKeyOnSuccess: 'tab-1:leaf-1',
      flashFocusedPane: true
    })

    expect(setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(dispatchEvent).not.toHaveBeenCalled()

    vi.advanceTimersByTime(99)
    expect(dispatchEvent).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    const event = dispatchEvent.mock.calls[0]?.[0] as MockCustomEvent<FocusTerminalPaneDetail>
    expect(event.type).toBe(FOCUS_TERMINAL_PANE_EVENT)
    expect(event.detail).toEqual({
      tabId: 'tab-1',
      leafId: 'leaf-1',
      ackPaneKeyOnSuccess: 'tab-1:leaf-1',
      flashFocusedPane: true
    })
  })

  it('cancels a pending pane focus frame when a newer activation starts', () => {
    const requestAnimationFrame = vi.fn()
    requestAnimationFrame.mockReturnValueOnce(12).mockReturnValueOnce(13)
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)

    activateTabAndFocusPane('tab-1', 'leaf-1')
    activateTabAndFocusPane('tab-2', 'leaf-2')

    expect(setActiveTab).toHaveBeenNthCalledWith(1, 'tab-1')
    expect(setActiveTab).toHaveBeenNthCalledWith(2, 'tab-2')
    expect(cancelAnimationFrame).toHaveBeenCalledWith(12)
    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})
