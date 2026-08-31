// @vitest-environment happy-dom
// STA-4476: the composing-chord deferral waits on the composition, not a deadline (#12871), so it
// is the sender that has to guarantee an exit — otherwise the wait and its listeners outlive the
// pane and a later composition flushes a stale chord.
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

    sender.defer({ code: 'ArrowLeft', timeStamp: 101 }, el, send)
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

    sender.defer({ code: 'ArrowLeft', timeStamp: 102 }, el, first)
    sender.defer({ code: 'ArrowLeft', timeStamp: 103 }, el, second)
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

    sender.defer({ code: 'ArrowLeft', timeStamp: 104 }, el, send)
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

    sender.defer({ code: 'ArrowLeft', timeStamp: 105 }, el, send)
    el.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(0)
    sender.cancelPending()
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('absorbs the replay of a held chord exactly once (#17616)', () => {
    // 2-Set Korean ends the composition on the chord and the platform replays that press
    // unmarked. Chromium keeps the original timeStamp on a re-dispatch, so the replay is
    // recognisable as the press it repeats — measured on stock macOS, both ArrowLeft keydowns
    // of one Option+← over a preedit report the same timeStamp.
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createTerminalImeDeferredChordSender()
    const chord = { code: 'ArrowLeft', timeStamp: 23884 }

    sender.defer(chord, el, send)

    expect(sender.absorbRedispatchedChord(chord)).toBe(true)
    // One press owes one credit, so a second replay is not this chord's and still gets through.
    expect(sender.absorbRedispatchedChord(chord)).toBe(false)
  })

  it('lets a different press through while a chord is held', () => {
    const el = document.createElement('div')
    const sender = createTerminalImeDeferredChordSender()

    sender.defer({ code: 'ArrowLeft', timeStamp: 23884 }, el, vi.fn())

    // A genuine second press carries its own timeStamp, and another key is not this chord at all.
    expect(sender.absorbRedispatchedChord({ code: 'ArrowLeft', timeStamp: 23999 })).toBe(false)
    expect(sender.absorbRedispatchedChord({ code: 'ArrowRight', timeStamp: 23884 })).toBe(false)
  })

  it('drops the credit once the deferral settles', () => {
    const el = document.createElement('div')
    const sender = createTerminalImeDeferredChordSender()
    const chord = { code: 'ArrowLeft', timeStamp: 23884 }

    sender.defer(chord, el, vi.fn())
    el.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(0)

    // Japanese and Chinese conversions swallow the chord instead of replaying it, so an unspent
    // credit must not sit waiting to eat an unrelated press later.
    expect(sender.absorbRedispatchedChord(chord)).toBe(false)
  })

  it('drops the credit when the chord is abandoned', () => {
    const el = document.createElement('div')
    const sender = createTerminalImeDeferredChordSender()
    const chord = { code: 'ArrowLeft', timeStamp: 23884 }

    sender.defer(chord, el, vi.fn())
    vi.advanceTimersByTime(TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS)

    expect(sender.absorbRedispatchedChord(chord)).toBe(false)
  })
})
