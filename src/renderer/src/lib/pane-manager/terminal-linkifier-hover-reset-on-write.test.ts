import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import * as hoverReset from './terminal-linkifier-hover-reset'
import { installTerminalLinkifierHoverResetOnWrite } from './terminal-linkifier-hover-reset-on-write'

// Spy while retaining real cache clearing: idempotent state alone cannot prove throttle/coalescing call counts.
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

  it('does not drop the reset when the stream goes quiet mid-hover', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    fake.linkifier._currentLink = { link: 'https://example.com' }
    fake.emitWriteParsed()
    // Many windows pass with NO further writes — the pending reset must survive.
    vi.advanceTimersByTime(600)
    expect(resetSpy).not.toHaveBeenCalled()

    // Hover-end retry must run without new output to rearm it.
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
    expect(resetSpy).not.toHaveBeenCalled()
    expect(fake.linkifier._lastBufferCell).toEqual({ x: 3, y: 4 })
  })
})
