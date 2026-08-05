// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyTransport } from './pty-transport'
import {
  createTerminalImeDeferredNewlineSender,
  createTerminalImeModifiedEnterChordOwner,
  isTerminalImeEnterKeyUp,
  isTerminalImeProcessEnter,
  sendTerminalInputAfterComposition
} from './terminal-ime-deferred-newline'
import {
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'

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

  it('finishes from the captured xterm transaction when deferral starts after compositionend', () => {
    const el = document.createElement('div')
    const send = vi.fn()

    sendTerminalInputAfterComposition(el, send)
    el.dispatchEvent(new CustomEvent(XTERM_COMPOSITION_SESSION_END_EVENT))
    vi.advanceTimersByTime(0)

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('waits for every overlapping captured xterm transaction', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const terminal = { input: vi.fn() }
    const transport = {
      getPtyId: () => 'pty-1'
    } as unknown as PtyTransport
    const route = installTerminalImeCompositionRoute({
      terminalElement: el,
      terminal,
      capturedTransport: transport,
      getCurrentTransport: () => transport
    })
    const sessionEvent = (type: string, id: number) =>
      new CustomEvent(type, { detail: { id, data: `commit-${id}` } })

    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_START_EVENT, 1))
    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_START_EVENT, 2))
    sendTerminalInputAfterComposition(el, send)
    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_END_EVENT, 1))
    vi.advanceTimersByTime(0)
    expect(send).not.toHaveBeenCalled()

    el.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_END_EVENT, 2))
    vi.advanceTimersByTime(0)
    expect(send).toHaveBeenCalledTimes(1)

    route.dispose()
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
  const enter = (timeStamp: number, code = 'Enter') => ({ code, timeStamp })

  it('absorbs the re-dispatch while the deferred send is still in flight, exactly once', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createSender()

    sender.defer(enter(10), el, send)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)

    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
    // The credit was consumed pre-send, so nothing lingers to eat a real Enter.
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })

  it('absorbs after the deferred send even if focus moved to another pane', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createSender()

    sender.defer(enter(10), el, send)
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })

  it('keeps a credit across the balancing keyup copied from the same native event', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    sender.releaseRedispatchedEnter(enter(10))
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
  })

  it('releases an unused credit on a later physical keyup', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    sender.releaseRedispatchedEnter(enter(11))
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })

  it('retires stale credit when a genuinely new Enter begins without a redispatch', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())

    expect(sender.absorbRedispatchedEnter(enter(20))).toBe(false)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })

  it('absorbs a matching repeated composition cycle but not a new plain repeat', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    expect(sender.absorbRedispatchedEnter(enter(20))).toBe(false)

    sender.defer(enter(30), el, vi.fn())
    expect(sender.absorbRedispatchedEnter(enter(30))).toBe(true)
  })

  it('tracks the main and numpad Enter keys independently', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    expect(sender.absorbRedispatchedEnter(enter(10, 'NumpadEnter'))).toBe(false)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
  })

  it('tracks two overlapping Enter cycles independently by native timestamp', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    sender.defer(enter(20), el, vi.fn())
    expect(sender.absorbRedispatchedEnter(enter(20))).toBe(true)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
    expect(sender.absorbRedispatchedEnter(enter(20))).toBe(false)
  })

  it('keeps a re-dispatch credit on the fallback path', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createSender()

    sender.defer(enter(10), el, send)
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
  })

  it('still delivers without a terminal element and keeps one credit', () => {
    const send = vi.fn()
    const sender = createSender()

    sender.defer(enter(10), null, send)
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })

  it('clears credits after a missed keyup when the window blurs', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    sender.clearRedispatchedEnters()
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })
})

describe('createTerminalImeModifiedEnterChordOwner', () => {
  const chord = (kind: 'shift' | 'ctrl', timeStamp: number, code = '') => ({
    kind,
    code,
    timeStamp
  })

  it('owns one Windows Process sequence across changing timestamps and blank codes', () => {
    const owner = createTerminalImeModifiedEnterChordOwner()
    const defer = vi.fn()

    for (const event of [chord('shift', 5035.8), chord('shift', 5036.9)]) {
      if (owner.claim(event)) {
        defer()
      }
    }

    expect(defer).toHaveBeenCalledTimes(1)
    expect(owner.absorb(chord('shift', 5037.9, 'Enter'))).toBe(true)
  })

  it('does not merge different modified Enter kinds into one chord', () => {
    const owner = createTerminalImeModifiedEnterChordOwner()

    expect(owner.claim(chord('shift', 10, 'Enter'))).toBe(true)
    expect(owner.claim(chord('ctrl', 11, 'Enter'))).toBe(false)
    expect(owner.absorb(chord('ctrl', 12, 'Enter'))).toBe(false)
  })

  it('releases at the physical key boundary so the next Enter is not consumed', () => {
    const owner = createTerminalImeModifiedEnterChordOwner()

    expect(owner.claim(chord('ctrl', 10))).toBe(true)
    owner.release(chord('ctrl', 30, 'Enter'))

    expect(owner.absorb(chord('ctrl', 40, 'Enter'))).toBe(false)
    expect(owner.claim(chord('ctrl', 40, 'Enter'))).toBe(true)
  })

  it('ignores a mismatched release and clears lost keyup state explicitly', () => {
    const owner = createTerminalImeModifiedEnterChordOwner()

    expect(owner.claim(chord('shift', 10))).toBe(true)
    owner.release(chord('ctrl', 20))
    expect(owner.absorb(chord('shift', 30))).toBe(true)
    owner.clear()

    expect(owner.absorb(chord('shift', 40))).toBe(false)
  })
})

describe('isTerminalImeProcessEnter', () => {
  const event = (overrides: Partial<KeyboardEvent> = {}) =>
    ({
      key: 'Process',
      code: 'Enter',
      keyCode: 229,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      ...overrides
    }) as KeyboardEvent

  it.each([
    { shiftKey: true },
    { shiftKey: false, ctrlKey: true },
    { code: 'NumpadEnter' },
    { code: '' },
    { code: 'Unidentified' }
  ])('recognizes a Windows IME modifier Enter reported as Process', (modifiers) => {
    expect(isTerminalImeProcessEnter(event(modifiers))).toBe(true)
  })

  it.each([
    { key: 'Enter' },
    { keyCode: 13 },
    { shiftKey: false },
    { ctrlKey: true },
    { altKey: true },
    { code: 'ShiftLeft' },
    { code: 'KeyQ' },
    { code: 'ArrowLeft' }
  ])('rejects a non-IME or ambiguous Process key', (override) => {
    expect(isTerminalImeProcessEnter(event(override))).toBe(false)
  })
})

describe('isTerminalImeEnterKeyUp', () => {
  it('recognizes the balancing Enter keyup when Chromium drops its modifier', () => {
    expect(isTerminalImeEnterKeyUp({ key: 'Enter', keyCode: 13 })).toBe(true)
  })

  it.each([
    { key: 'Process', keyCode: 13 },
    { key: 'Enter', keyCode: 229 }
  ])('rejects a non-Enter balancing event', (event) => {
    expect(isTerminalImeEnterKeyUp(event)).toBe(false)
  })
})
