import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateTabAndFocusPane } from './activate-tab-and-focus-pane'

const setActiveTab = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      setActiveTab
    })
  }
}))

describe('activateTabAndFocusPane', () => {
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
})
