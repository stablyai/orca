// @vitest-environment happy-dom
// STA-4476: the composing-chord deferral waits on the composition, not a deadline (#12871), so it
// is the sender that has to guarantee an exit — otherwise the wait and its listeners outlive the
// pane and a later composition flushes a stale chord.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalImeDeferredChordSender,
  TERMINAL_IME_CHORD_REPLAY_WINDOW_MS,
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

  it('absorbs the replay that follows the commit, not one that precedes it (#17616)', () => {
    // The real order on 2-Set Korean: the chord ends the composition, the commit releases the
    // held chord, and only then does the platform replay the same press unmarked. A credit that
    // died with the composition would be gone exactly when the replay needs it.
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createTerminalImeDeferredChordSender()
    const chord = { code: 'ArrowLeft', timeStamp: 23884 }

    sender.defer(chord, el, send)
    el.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(0)
    expect(send).toHaveBeenCalledTimes(1)

    expect(sender.absorbRedispatchedChord(chord)).toBe(true)
    // One press owes one credit, so a second replay is not this chord's and still gets through.
    expect(sender.absorbRedispatchedChord(chord)).toBe(false)
  })

  it('spends the credit even while the chord is still held', () => {
    // Absorbing while held must still decrement: the state stays in the map until the commit, so
    // a credit that is checked but never spent would swallow every replay of that press.
    const el = document.createElement('div')
    const sender = createTerminalImeDeferredChordSender()
    const chord = { code: 'ArrowLeft', timeStamp: 23884 }

    sender.defer(chord, el, vi.fn())

    expect(sender.absorbRedispatchedChord(chord)).toBe(true)
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

  it('lets a different press through after the credit has been spent', () => {
    const el = document.createElement('div')
    const sender = createTerminalImeDeferredChordSender()
    const chord = { code: 'ArrowLeft', timeStamp: 23884 }

    sender.defer(chord, el, vi.fn())
    el.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(0)
    sender.absorbRedispatchedChord(chord)

    expect(sender.absorbRedispatchedChord({ code: 'ArrowLeft', timeStamp: 23999 })).toBe(false)
  })

  it('drops an unspent credit rather than keeping it for the life of the pane', () => {
    const el = document.createElement('div')
    const sender = createTerminalImeDeferredChordSender()
    const chord = { code: 'ArrowLeft', timeStamp: 23884 }

    // Japanese and Chinese conversions swallow the chord instead of replaying it, so this credit
    // is never spent. It may outlive the commit — the replay lands after it — but not for long.
    sender.defer(chord, el, vi.fn())
    el.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(0)
    expect(sender.absorbRedispatchedChord(chord)).toBe(true)

    sender.defer(chord, el, vi.fn())
    el.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(TERMINAL_IME_CHORD_REPLAY_WINDOW_MS)
    expect(sender.absorbRedispatchedChord(chord)).toBe(false)
  })

  it('drops the credit when the chord is abandoned unsent', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createTerminalImeDeferredChordSender()
    const chord = { code: 'ArrowLeft', timeStamp: 23884 }

    sender.defer(chord, el, send)
    vi.advanceTimersByTime(TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS)
    expect(send).not.toHaveBeenCalled()

    // Nothing was sent, so nothing is owed an absorb; the credit goes with its own window.
    vi.advanceTimersByTime(TERMINAL_IME_CHORD_REPLAY_WINDOW_MS)
    expect(sender.absorbRedispatchedChord(chord)).toBe(false)
  })
})
