// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendTerminalInputAfterComposition } from './terminal-ime-deferred-newline'

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
