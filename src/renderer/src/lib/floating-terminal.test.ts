import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeFloatingTerminalOpenMaximizedIntent,
  requestFloatingTerminalOpenMaximized
} from './floating-terminal'

describe('floating terminal open-maximized intent', () => {
  afterEach(() => {
    vi.useRealTimers()
    consumeFloatingTerminalOpenMaximizedIntent()
  })

  it('returns true exactly once after a request', () => {
    requestFloatingTerminalOpenMaximized()

    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(true)
    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(false)
  })

  it('returns false when no request was made', () => {
    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(false)
  })

  it('expires a stale intent so an abandoned open does not leak into a later open', () => {
    vi.useFakeTimers()
    requestFloatingTerminalOpenMaximized()

    // An abandoned open must not leave maximize intent for a later ordinary open.
    vi.advanceTimersByTime(2001)

    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(false)
  })

  it('still honors an intent consumed within the same interaction window', () => {
    vi.useFakeTimers()
    requestFloatingTerminalOpenMaximized()

    vi.advanceTimersByTime(50)

    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(true)
  })
})
