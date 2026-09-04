import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateTabAndFocusPane } from './activate-tab-and-focus-pane'
import { FOCUS_TERMINAL_PANE_EVENT } from '@/constants/terminal'

const setActiveTab = vi.hoisted(() => vi.fn())
const setActiveTabType = vi.hoisted(() => vi.fn())
const setTabViewMode = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      setActiveTab,
      setActiveTabType,
      setTabViewMode
    })
  }
}))

describe('activateTabAndFocusPane', () => {
  beforeEach(() => {
    setActiveTab.mockImplementation(() => undefined)
    setActiveTabType.mockImplementation(() => undefined)
    setTabViewMode.mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('cancels a pending pane focus frame when a newer activation starts', () => {
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 12)
    )
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn()
    })

    activateTabAndFocusPane('tab-1', 'leaf-1')
    activateTabAndFocusPane('tab-2', 'leaf-2')

    expect(setActiveTab).toHaveBeenNthCalledWith(1, 'tab-1')
    expect(setActiveTab).toHaveBeenNthCalledWith(2, 'tab-2')
    expect(cancelAnimationFrame).toHaveBeenCalledWith(12)
  })

  it('reveals the terminal surface before selecting the terminal tab', () => {
    const callOrder: string[] = []
    setActiveTabType.mockImplementation((tabType: string) => {
      callOrder.push(`type:${tabType}`)
    })
    setActiveTab.mockImplementation((tabId: string) => {
      callOrder.push(`tab:${tabId}`)
    })
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 12)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn()
    })

    activateTabAndFocusPane('tab-1', 'leaf-1')

    expect(callOrder).toEqual(['type:terminal', 'tab:tab-1'])
  })

  it('focuses a chat tab without changing its view mode', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => callback(0))
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('window', { dispatchEvent })

    activateTabAndFocusPane('chat-tab', 'chat-leaf')

    expect(setActiveTab).toHaveBeenCalledWith('chat-tab')
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: FOCUS_TERMINAL_PANE_EVENT,
        detail: { tabId: 'chat-tab', leafId: 'chat-leaf' }
      })
    )
    expect(setTabViewMode).not.toHaveBeenCalled()
  })

  it('reveals the terminal surface for tab-only activation without dispatching pane focus', () => {
    const requestAnimationFrame = vi.fn()
    const dispatchEvent = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('window', {
      dispatchEvent
    })

    activateTabAndFocusPane('tab-1', null)

    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})
