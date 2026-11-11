import { describe, expect, it, vi } from 'vitest'
import { closeSetupPageWhenCreateTakesOver, SETUP_HANDOFF_MAX_MS } from './cloud-setup-handoff'

function harness(initial: { activePendingCreationId: string | null; activeModal: string }) {
  let state = { ...initial }
  const listeners = new Set<(s: typeof state) => void>()
  const closePage = vi.fn()
  const set = (patch: Partial<typeof state>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) {
      listener(state)
    }
  }
  const cancel = closeSetupPageWhenCreateTakesOver({
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    closePage,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  })
  return { set, closePage, cancel, listeners }
}

describe('closeSetupPageWhenCreateTakesOver', () => {
  it('keeps the setup page up until the start screen is the active surface', () => {
    vi.useFakeTimers()
    const h = harness({ activePendingCreationId: null, activeModal: 'new-workspace-composer' })
    // The hidden composer is still filling in: the page must cover the workspace underneath.
    vi.advanceTimersByTime(3_000)
    expect(h.closePage).not.toHaveBeenCalled()
    // Submit publishes the pending create and closes the composer in one go.
    h.set({ activePendingCreationId: 'c1', activeModal: 'none' })
    expect(h.closePage).toHaveBeenCalledOnce()
    expect(h.listeners.size).toBe(0)
    vi.useRealTimers()
  })

  it('waits a tick when the composer closes before the create is published', () => {
    vi.useFakeTimers()
    const h = harness({ activePendingCreationId: null, activeModal: 'new-workspace-composer' })
    h.set({ activeModal: 'none' })
    expect(h.closePage).not.toHaveBeenCalled()
    h.set({ activePendingCreationId: 'c1' })
    expect(h.closePage).toHaveBeenCalledOnce()
    vi.runAllTimers()
    expect(h.closePage).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('ignores an older active create and gives up after the reveal window', () => {
    vi.useFakeTimers()
    const h = harness({ activePendingCreationId: 'old', activeModal: 'new-workspace-composer' })
    h.set({ activePendingCreationId: 'old' })
    expect(h.closePage).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SETUP_HANDOFF_MAX_MS)
    expect(h.closePage).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
