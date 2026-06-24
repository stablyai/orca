import { describe, expect, it, vi } from 'vitest'
import { createTestStore, makeLayout, seedStore } from './store-test-helpers'

describe('terminal scroll state updates', () => {
  it('does not notify store subscribers for unchanged scroll states', () => {
    const store = createTestStore()
    const scrollStatesByLeafId = {
      leafA: {
        bufferType: 'normal' as const,
        wasAtBottom: false,
        viewportY: 12,
        baseY: 20
      }
    }
    seedStore(store, {
      terminalLayoutsByTabId: {
        tabA: {
          ...makeLayout(),
          scrollStatesByLeafId
        }
      }
    })
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    store.getState().updateTabScrollStates('tabA', { ...scrollStatesByLeafId })
    store.getState().updateTabScrollStates('tabA', {
      leafA: {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 13,
        baseY: 20
      }
    })
    unsubscribe()

    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(store.getState().terminalLayoutsByTabId.tabA.scrollStatesByLeafId?.leafA).toMatchObject({
      viewportY: 13
    })
  })
})
