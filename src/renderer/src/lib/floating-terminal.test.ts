import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeFloatingTerminalOpenMaximizedIntent,
  requestFloatingTerminalOpenMaximized,
  shouldOpenFloatingTerminalOnRequest,
  shouldForceCloseFloatingTerminal
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
})

describe('floating terminal open/close policy for activity links (#7813)', () => {
  // Table-driven: covers the case where floatingTerminalEnabled=false but a
  // browser tab was created from Agents View terminal link (count>0) => must
  // open and must not force-close.
  const cases: {
    enabled: boolean
    count: number
    open: boolean
    forceClose: boolean
    note: string
  }[] = [
    { enabled: true, count: 0, open: true, forceClose: false, note: 'normal enabled, no tabs' },
    { enabled: true, count: 1, open: true, forceClose: false, note: 'enabled with tab' },
    { enabled: false, count: 0, open: false, forceClose: true, note: 'disabled, no tabs => closed' },
    { enabled: false, count: 1, open: true, forceClose: false, note: 'activity link case: disabled but count>0 => open for browser in Agents View' },
    { enabled: false, count: 2, open: true, forceClose: false, note: 'multiple tabs while pref off' }
  ]

  it.each(cases)('shouldOpen($enabled, $count) => $open; shouldForceClose => $forceClose ($note)', ({ enabled, count, open, forceClose }) => {
    expect(shouldOpenFloatingTerminalOnRequest({ enabled, visibleTabCount: count })).toBe(open)
    expect(shouldForceCloseFloatingTerminal({ enabled, visibleTabCount: count })).toBe(forceClose)
  })
})
