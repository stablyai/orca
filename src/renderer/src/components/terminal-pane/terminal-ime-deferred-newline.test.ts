// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalImeDeferredNewlineSender,
  sendTerminalInputAfterComposition,
  TERMINAL_IME_ENTER_REDISPATCH_ABSORB_WINDOW_MS
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

  const createSender = () => createTerminalImeDeferredNewlineSender()

  it('absorbs the re-dispatch while the deferred send is still in flight, exactly once', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createSender()

    sender.defer(1, el, send)
    expect(sender.absorbRedispatchedEnter(1)).toBe(true)
    expect(sender.absorbRedispatchedEnter(1)).toBe(false)

    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
    // The credit was consumed pre-send, so nothing lingers to eat a real Enter.
    expect(sender.absorbRedispatchedEnter(1)).toBe(false)
  })

  it('absorbs the re-dispatch shortly after the deferred send fired', () => {
    // Why: when the send's macrotask beats the re-dispatched keydown, the
    // duplicate arrives a few ms after the newline went out.
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createSender()

    sender.defer(1, el, send)
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(TERMINAL_IME_ENTER_REDISPATCH_ABSORB_WINDOW_MS)
    expect(sender.absorbRedispatchedEnter(1)).toBe(true)
    expect(sender.absorbRedispatchedEnter(1)).toBe(false)
  })

  it('expires the post-send absorb window so a later real Enter is never eaten', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(1, el, vi.fn())
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    vi.advanceTimersByTime(TERMINAL_IME_ENTER_REDISPATCH_ABSORB_WINDOW_MS + 1)
    expect(sender.absorbRedispatchedEnter(1)).toBe(false)
  })

  it('tracks panes independently', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(1, el, vi.fn())
    expect(sender.absorbRedispatchedEnter(2)).toBe(false)
    expect(sender.absorbRedispatchedEnter(1)).toBe(true)
  })

  it('grants one credit per overlapping defer on the same pane', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(1, el, vi.fn())
    sender.defer(1, el, vi.fn())
    expect(sender.absorbRedispatchedEnter(1)).toBe(true)
    expect(sender.absorbRedispatchedEnter(1)).toBe(true)
    expect(sender.absorbRedispatchedEnter(1)).toBe(false)
  })

  it('arms the absorb window on the fallback path too', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createSender()

    sender.defer(1, el, send)
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    expect(sender.absorbRedispatchedEnter(1)).toBe(true)
  })

  it('still delivers without a terminal element and arms the absorb window', () => {
    const send = vi.fn()
    const sender = createSender()

    sender.defer(1, null, send)
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
    expect(sender.absorbRedispatchedEnter(1)).toBe(true)
    expect(sender.absorbRedispatchedEnter(1)).toBe(false)
  })
})
