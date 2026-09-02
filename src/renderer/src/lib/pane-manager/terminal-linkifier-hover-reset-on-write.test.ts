import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import * as hoverReset from './terminal-linkifier-hover-reset'
import { installTerminalLinkifierHoverResetOnWrite } from './terminal-linkifier-hover-reset-on-write'

// Spy on the reset primitive while keeping its real field-clearing behavior, so
// tests can COUNT invocations — the throttle/coalesce properties are otherwise
// invisible (the reset writes idempotent cache state).
vi.mock('./terminal-linkifier-hover-reset', async (importOriginal) => {
  const actual = await importOriginal<typeof hoverReset>()
  return {
    ...actual,
    resetTerminalLinkifierHoverState: vi.fn(actual.resetTerminalLinkifierHoverState)
  }
})

type LinkifierCache = { _lastBufferCell?: unknown; _activeLine?: number; _currentLink?: unknown }

function createFakeTerminal(): {
  terminal: Terminal
  emitWriteParsed: () => void
  linkifier: LinkifierCache
  listenerDisposed: () => boolean
} {
  const listeners = new Set<() => void>()
  let disposed = false
  const linkifier: LinkifierCache = {
    _lastBufferCell: { x: 3, y: 4 },
    _activeLine: 4,
    _currentLink: undefined
  }
  const terminal = {
    onWriteParsed: (handler: () => void) => {
      listeners.add(handler)
      return {
        dispose: () => {
          disposed = true
          listeners.delete(handler)
        }
      }
    },
    _core: { linkifier }
  } as unknown as Terminal
  return {
    terminal,
    emitWriteParsed: () => listeners.forEach((handler) => handler()),
    linkifier,
    listenerDisposed: () => disposed
  }
}

const resetSpy = vi.mocked(hoverReset.resetTerminalLinkifierHoverState)

describe('installTerminalLinkifierHoverResetOnWrite', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSpy.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('clears the linkifier hover cache a throttle window after output lands', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    fake.emitWriteParsed()
    // Not reset synchronously — throttled so streaming does not re-query per chunk.
    expect(resetSpy).not.toHaveBeenCalled()
    expect(fake.linkifier._lastBufferCell).toBeDefined()

    vi.advanceTimersByTime(150)
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(fake.linkifier._lastBufferCell).toBeUndefined()
    expect(fake.linkifier._activeLine).toBe(-1)
  })

  it('coalesces a burst of writes into exactly one reset per window', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    // 20 chunks inside one window must schedule only one reset — not 20. This
    // fails if the leading-edge throttle guard is removed.
    for (let i = 0; i < 20; i += 1) {
      fake.emitWriteParsed()
      vi.advanceTimersByTime(5)
    }
    vi.advanceTimersByTime(150)
    expect(resetSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps resetting during continuous streaming instead of starving', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    // A chunk every 50ms for 500ms. The throttle fires ~every 150ms; a debounce
    // (clearTimeout + reschedule per chunk) would never fire while the stream
    // continues — that regression is what this guards against.
    for (let i = 0; i < 10; i += 1) {
      fake.emitWriteParsed()
      vi.advanceTimersByTime(50)
    }
    expect(resetSpy.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('does not disturb an actively hovered link, and resumes once it clears', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    fake.linkifier._currentLink = { link: 'https://example.com' }
    fake.emitWriteParsed()
    vi.advanceTimersByTime(150)
    // Hovering: the cache is left intact so the underline/tooltip do not flicker.
    expect(resetSpy).not.toHaveBeenCalled()
    expect(fake.linkifier._lastBufferCell).toBeDefined()

    fake.linkifier._currentLink = undefined
    fake.emitWriteParsed()
    vi.advanceTimersByTime(150)
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(fake.linkifier._lastBufferCell).toBeUndefined()
  })

  it('does not drop the reset when the stream goes quiet mid-hover', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    // Last chunk of a burst lands while a link is hovered, then output stops.
    fake.linkifier._currentLink = { link: 'https://example.com' }
    fake.emitWriteParsed()
    // Many windows pass with NO further writes — the pending reset must survive.
    vi.advanceTimersByTime(600)
    expect(resetSpy).not.toHaveBeenCalled()

    // Once the pointer leaves the link, the retry finally resets — without any
    // new output re-arming it.
    fake.linkifier._currentLink = undefined
    vi.advanceTimersByTime(150)
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(fake.linkifier._lastBufferCell).toBeUndefined()
  })

  it('cancels the pending reset and detaches the listener on dispose', () => {
    const fake = createFakeTerminal()
    const disposable = installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    fake.emitWriteParsed()
    disposable.dispose()
    expect(fake.listenerDisposed()).toBe(true)

    vi.advanceTimersByTime(500)
    // Disposed before the timer fired: no reset, cache untouched.
    expect(resetSpy).not.toHaveBeenCalled()
    expect(fake.linkifier._lastBufferCell).toEqual({ x: 3, y: 4 })
  })

  it('degrades to a no-op when the terminal lacks onWriteParsed', () => {
    const terminal = { _core: { linkifier: {} } } as unknown as Terminal
    expect(() => installTerminalLinkifierHoverResetOnWrite(terminal).dispose()).not.toThrow()
  })
})
