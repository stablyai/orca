// @vitest-environment happy-dom
// Composition waits need sender-owned blur/teardown exits or a later session can flush a stale chord (#12871, STA-4476).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalImeDeferredChordSender,
  TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS
} from './terminal-ime-deferred-chord'
import { XTERM_COMPOSITION_SESSION_END_EVENT } from './terminal-ime-composition-route'

describe('createTerminalImeDeferredChordSender', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends once the composition commits', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createTerminalImeDeferredChordSender()

    sender.defer({ code: 'ArrowLeft', timeStamp: 1 }, el, send)
    expect(send).not.toHaveBeenCalled()

    el.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('cancels every pending chord and detaches its listeners', () => {
    const el = document.createElement('div')
    const removeEventListener = vi.spyOn(el, 'removeEventListener')
    const first = vi.fn()
    const second = vi.fn()
    const sender = createTerminalImeDeferredChordSender()

    sender.defer({ code: 'ArrowLeft', timeStamp: 1 }, el, first)
    sender.defer({ code: 'ArrowLeft', timeStamp: 1 }, el, second)
    sender.cancelPending()

    expect(removeEventListener).toHaveBeenCalledTimes(4)

    el.dispatchEvent(new Event('compositionend'))
    el.dispatchEvent(new CustomEvent(XTERM_COMPOSITION_SESSION_END_EVENT))
    vi.runAllTimers()
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('abandons a chord whose composition never ends rather than sending it late', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createTerminalImeDeferredChordSender()

    sender.defer({ code: 'ArrowLeft', timeStamp: 1 }, el, send)
    vi.advanceTimersByTime(TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS - 1)
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2)
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).not.toHaveBeenCalled()
  })

  it('stops tracking a chord that already sent, so a later cancel is inert', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createTerminalImeDeferredChordSender()

    sender.defer({ code: 'ArrowLeft', timeStamp: 1 }, el, send)
    el.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(0)
    sender.cancelPending()
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
  })
})
