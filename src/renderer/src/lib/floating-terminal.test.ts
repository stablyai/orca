import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeFloatingTerminalOpenMaximizedIntent,
  requestFloatingTerminalOpenMaximized,
  shouldForceCloseFloatingTerminal,
  shouldMountFloatingTerminalPanel,
  shouldOpenFloatingTerminalOnRequest
} from './floating-terminal'

describe('floating terminal open-maximized intent', () => {
  afterEach(() => {
    vi.useRealTimers()
    // Drain any leftover intent so it cannot bleed into an unrelated test.
    consumeFloatingTerminalOpenMaximizedIntent()
  })

  it('returns true exactly once after a request', () => {
    requestFloatingTerminalOpenMaximized()

    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(true)
    // One-shot: a second consume without a new request is false.
    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(false)
  })

  it('returns false when no request was made', () => {
    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(false)
  })

  it('expires a stale intent so an abandoned open does not leak into a later open', () => {
    vi.useFakeTimers()
    requestFloatingTerminalOpenMaximized()

    // Why: the open was abandoned (prevented/interrupted before the panel
    // mounted); a much-later ordinary open must not consume the stale intent.
    vi.advanceTimersByTime(2001)

    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(false)
  })

  it('still honors an intent consumed within the same interaction window', () => {
    vi.useFakeTimers()
    requestFloatingTerminalOpenMaximized()

    vi.advanceTimersByTime(50)

    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(true)
  })

  it('opens on request when the preference is enabled', () => {
    expect(shouldOpenFloatingTerminalOnRequest({ enabled: true, visibleTabCount: 0 })).toBe(true)
  })

  it('opens on request when floating tabs already exist', () => {
    expect(shouldOpenFloatingTerminalOnRequest({ enabled: false, visibleTabCount: 1 })).toBe(true)
  })

  it('does not force-close while floating tabs remain', () => {
    expect(shouldForceCloseFloatingTerminal({ enabled: false, visibleTabCount: 1 })).toBe(false)
  })

  it('force-closes only when disabled and empty', () => {
    expect(shouldForceCloseFloatingTerminal({ enabled: false, visibleTabCount: 0 })).toBe(true)
  })

  it('does not mount while enabled, closed, and empty', () => {
    expect(
      shouldMountFloatingTerminalPanel({ enabled: true, open: false, visibleTabCount: 0 })
    ).toBe(false)
  })

  it('mounts while enabled and open', () => {
    expect(
      shouldMountFloatingTerminalPanel({ enabled: true, open: true, visibleTabCount: 0 })
    ).toBe(true)
  })

  it('keeps visible floating tabs mounted while disabled and closed', () => {
    expect(
      shouldMountFloatingTerminalPanel({ enabled: false, open: false, visibleTabCount: 1 })
    ).toBe(true)
  })
})
