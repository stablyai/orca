// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalImeDeferredNewlineSender,
  sendTerminalInputAfterComposition
} from './terminal-ime-deferred-newline'

describe('sendTerminalInputAfterComposition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the newline one macrotask after compositionend so the glyph flushes first', () => {
    const el = document.createElement('div')
    const send = vi.fn()

    sendTerminalInputAfterComposition(el, send)
    expect(send).not.toHaveBeenCalled()

    el.dispatchEvent(new Event('compositionend'))
    // Deferred a macrotask so xterm's own post-compositionend flush runs first.
    expect(send).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('falls back to sending when no compositionend arrives', () => {
    const el = document.createElement('div')
    const send = vi.fn()

    sendTerminalInputAfterComposition(el, send)
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends only once and drops the listener after firing', () => {
    const el = document.createElement('div')
    const send = vi.fn()

    sendTerminalInputAfterComposition(el, send)
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    // A later composition on the same terminal must not re-fire the stale newline.
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not double-send when compositionend arrives after the fallback fired', () => {
    const el = document.createElement('div')
    const send = vi.fn()

    sendTerminalInputAfterComposition(el, send)
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('still delivers the input on the next macrotask without a terminal element', () => {
    const send = vi.fn()

    sendTerminalInputAfterComposition(null, send)
    expect(send).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('createTerminalImeDeferredNewlineSender', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks the pane pending until the deferred newline is sent', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createTerminalImeDeferredNewlineSender()

    sender.defer(1, el, send)
    // Why: this window is when macOS Hangul's re-dispatched committing Enter
    // keydown (isComposing=false) arrives and must be identified as a duplicate.
    expect(sender.isDeferredNewlinePending(1)).toBe(true)

    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
    expect(sender.isDeferredNewlinePending(1)).toBe(false)
  })

  it('clears pending via the no-compositionend fallback too', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createTerminalImeDeferredNewlineSender()

    sender.defer(1, el, send)
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
    expect(sender.isDeferredNewlinePending(1)).toBe(false)
  })

  it('tracks panes independently', () => {
    const el1 = document.createElement('div')
    const el2 = document.createElement('div')
    const sender = createTerminalImeDeferredNewlineSender()

    sender.defer(1, el1, vi.fn())
    expect(sender.isDeferredNewlinePending(1)).toBe(true)
    expect(sender.isDeferredNewlinePending(2)).toBe(false)

    sender.defer(2, el2, vi.fn())
    el1.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(0)
    expect(sender.isDeferredNewlinePending(1)).toBe(false)
    expect(sender.isDeferredNewlinePending(2)).toBe(true)
  })

  it('settles fully when overlapping defers for the same pane both send', () => {
    const el = document.createElement('div')
    const sender = createTerminalImeDeferredNewlineSender()

    sender.defer(1, el, vi.fn())
    sender.defer(1, el, vi.fn())
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    expect(sender.isDeferredNewlinePending(1)).toBe(false)
  })

  it('still delivers without a terminal element and settles pending', () => {
    const send = vi.fn()
    const sender = createTerminalImeDeferredNewlineSender()

    sender.defer(1, null, send)
    expect(sender.isDeferredNewlinePending(1)).toBe(true)
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
    expect(sender.isDeferredNewlinePending(1)).toBe(false)
  })
})
