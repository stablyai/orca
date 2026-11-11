import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeSetupPageWhenCreateTakesOver,
  SETUP_HANDOFF_MAX_MS,
  SETUP_HANDOFF_PAINT_MAX_MS
} from './cloud-setup-handoff'

function harness(initial: { activePendingCreationId: string | null; activeModal: string }) {
  let state = { ...initial }
  let painted = false
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
    startScreenShown: () => painted,
    closePage,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle)
  })
  return { set, paint: () => (painted = true), closePage, cancel, listeners }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('closeSetupPageWhenCreateTakesOver', () => {
  it('keeps the setup page up until the start screen has painted', () => {
    vi.useFakeTimers()
    const h = harness({ activePendingCreationId: null, activeModal: 'new-workspace-composer' })
    // The hidden composer is still filling in: the page must cover the workspace underneath.
    vi.advanceTimersByTime(3_000)
    expect(h.closePage).not.toHaveBeenCalled()
    // Submit publishes the pending create and closes the composer in one go.
    h.set({ activePendingCreationId: 'c1', activeModal: 'none' })
    // Its start screen's chunk hasn't rendered yet: still covered, never a bare frame.
    vi.advanceTimersByTime(200)
    expect(h.closePage).not.toHaveBeenCalled()
    h.paint()
    vi.advanceTimersByTime(20)
    expect(h.closePage).toHaveBeenCalledOnce()
    expect(h.listeners.size).toBe(0)
  })

  it('does not give up on a create published a tick after the composer closed', () => {
    vi.useFakeTimers()
    const h = harness({ activePendingCreationId: null, activeModal: 'new-workspace-composer' })
    h.set({ activeModal: 'none' })
    h.set({ activePendingCreationId: 'c1' })
    vi.advanceTimersByTime(100)
    expect(h.closePage).not.toHaveBeenCalled()
    h.paint()
    vi.advanceTimersByTime(20)
    expect(h.closePage).toHaveBeenCalledOnce()
  })

  it('closes when the composer goes away without a create', () => {
    vi.useFakeTimers()
    const h = harness({ activePendingCreationId: null, activeModal: 'new-workspace-composer' })
    h.set({ activeModal: 'none' })
    vi.advanceTimersByTime(1)
    expect(h.closePage).toHaveBeenCalledOnce()
  })

  it('ignores an older active create, and never covers longer than its caps', () => {
    vi.useFakeTimers()
    const h = harness({ activePendingCreationId: 'old', activeModal: 'new-workspace-composer' })
    h.set({ activePendingCreationId: 'old' })
    expect(h.closePage).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SETUP_HANDOFF_MAX_MS)
    expect(h.closePage).toHaveBeenCalledOnce()

    const unpainted = harness({ activePendingCreationId: null, activeModal: 'none' })
    unpainted.set({ activePendingCreationId: 'c2' })
    vi.advanceTimersByTime(SETUP_HANDOFF_PAINT_MAX_MS + 20)
    expect(unpainted.closePage).toHaveBeenCalledOnce()
  })
})
