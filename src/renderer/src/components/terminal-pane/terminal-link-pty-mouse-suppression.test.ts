// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTerminalLinkPtyMouseSuppression } from './terminal-link-pty-mouse-suppression'
import { installTerminalLinkPointerGesture } from './terminal-link-pointer-gesture'

const disposers: (() => void)[] = []
const DOWN = '\x1b[<0;1;1M'
const UP = '\x1b[<0;1;1m'
function mouse(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'mouseup' ? 0 : 1,
    ...init
  })
}
function mount(actions = true) {
  const element = document.createElement('div')
  document.body.append(element)
  const writes: string[] = []
  let live = true
  let selected = false
  let candidate: string | null = 'url:1:1:20'
  const clearSelection = vi.fn(() => {
    selected = false
  })
  const terminal = { element, clearSelection, hasSelection: () => selected }
  const registration = vi.spyOn(element, 'addEventListener')
  const tracker = actions ? installTerminalLinkPointerGesture(terminal) : null
  const trackerElementHandlers = registration.mock.calls.length
  const owner = installTerminalLinkPtyMouseSuppression(terminal, {
    candidate: () => candidate,
    eligible: (event) => actions && (event.metaKey || tracker?.canRequestAction(event) === true),
    canContinue: (event) => tracker?.canRequestAction(event) === true
  })
  const ownerElementHandlers = registration.mock.calls.length - trackerElementHandlers
  const forward = (data: string): void => {
    if (live) writes.push(data)
  }
  owner.bindSource({ isCurrent: () => live, user: forward, unclassified: forward })
  element.addEventListener('mousedown', () => owner.handlePtyInput(DOWN, forward, true))
  element.addEventListener('mouseup', () => owner.handlePtyInput(UP, forward, true))
  disposers.push(() => {
    owner.dispose()
    tracker?.dispose()
    element.remove()
  })
  return {
    element,
    owner,
    ownerElementHandlers,
    trackerElementHandlers,
    writes,
    forward,
    clearSelection,
    select: () => {
      selected = true
    },
    candidate: (value: string | null) => {
      candidate = value
    },
    retire: () => {
      live = false
      owner.invalidateSource()
    }
  }
}
async function release(element: HTMLElement): Promise<void> {
  element.dispatchEvent(mouse('mouseup'))
  await new Promise((resolve) => setTimeout(resolve, 0))
}
afterEach(() => {
  disposers
    .splice(0)
    .toReversed()
    .forEach((dispose) => dispose())
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('production link input owner', () => {
  it('consumes before unconditional originating selection cleanup and reentrant effects', async () => {
    const f = mount()
    const effect = vi.fn(() => {
      expect(f.clearSelection).toHaveBeenCalledOnce()
      f.owner.reset()
      f.owner.handlePtyInput('reentrant-key', f.forward, true)
    })
    f.element.addEventListener('mouseup', (event) =>
      expect(f.owner.commitPointer(event, 'url:1:1:20', effect)).toBe(true)
    )
    f.element.dispatchEvent(mouse('mousedown'))
    await release(f.element)
    expect(f.writes).toEqual(['reentrant-key'])
    expect(effect).toHaveBeenCalledOnce()
  })

  it.each(['none', 'selection', 'drag', 'target', 'retired'] as const)(
    'preserves refused %s input without a late claim',
    async (reason) => {
      const f = mount(reason !== 'none')
      if (reason === 'selection') {
        f.select()
      }
      f.element.dispatchEvent(mouse('mousedown'))
      if (reason === 'drag') {
        f.element.dispatchEvent(mouse('mousemove', { clientX: 20 }))
      }
      if (reason === 'target') {
        f.candidate('another-range')
      }
      if (reason === 'retired') {
        f.retire()
      }
      const effect = vi.fn()
      f.element.addEventListener('mouseup', (event) =>
        expect(
          f.owner.commitPointer(event, reason === 'target' ? 'another-range' : 'url:1:1:20', effect)
        ).toBe(false)
      )
      await release(f.element)
      expect(effect).not.toHaveBeenCalled()
      expect(f.writes).toEqual(reason === 'retired' ? [] : [DOWN, UP])
    }
  )

  it('pins the physical tail to its original source across reset and replacement', async () => {
    const f = mount()
    const successor = vi.fn()
    f.element.dispatchEvent(mouse('mousedown'))
    f.owner.bindSource({ isCurrent: () => true, user: successor, unclassified: successor })
    await release(f.element)
    expect(f.writes).toEqual([DOWN, UP])
    expect(successor).not.toHaveBeenCalled()
    f.element.dispatchEvent(mouse('mousedown'))
    await release(f.element)
    expect(successor.mock.calls.map(([text]) => text)).toEqual([DOWN, UP])
  })

  it('ends a pressured transaction at 64 frames without reacquiring application ownership', async () => {
    const f = mount()
    f.element.addEventListener('mousedown', () => {
      for (let i = 0; i < 64; i++) {
        f.owner.handlePtyInput(DOWN, f.forward, true)
      }
    })
    f.element.dispatchEvent(mouse('mousedown'))
    expect(f.writes).toHaveLength(65)
    f.element.addEventListener('mouseup', (event) =>
      expect(f.owner.commitPointer(event, 'url:1:1:20', vi.fn())).toBe(false)
    )
    await release(f.element)
    expect(f.writes).toHaveLength(66)
  })

  it('keeps cursor and ordinary input immediate and finishes detached frames despite a throwing sender', () => {
    const f = mount()
    f.element.dispatchEvent(mouse('mousedown'))
    f.owner.handlePtyInput('\x1b[A', f.forward, true)
    expect(f.writes).toEqual(['\x1b[A'])
    expect(() => f.owner.reset()).not.toThrow()
    expect(f.writes).toEqual(['\x1b[A', DOWN])
    const other = mount()
    const failure = new Error('write failed')
    const attempts = vi.fn(() => {
      throw failure
    })
    other.owner.bindSource({ isCurrent: () => true, user: attempts, unclassified: attempts })
    other.element.dispatchEvent(mouse('mousedown'))
    expect(() => other.owner.dispose()).toThrow(failure)
    expect(attempts).toHaveBeenCalledOnce()
  })

  it.each([10, 100])(
    'bounds actual registrations/callbacks and forwards positive input with %i inactive owners',
    async (n) => {
      const probe = document.createElement('div')
      const doc = probe.ownerDocument
      const win = doc.defaultView
      if (!win) {
        throw new Error('Missing owner window')
      }
      const records: {
        target: EventTarget
        type: string
        original: EventListenerOrEventListenerObject
        wrapped: EventListener
      }[] = []
      let callbacks = 0
      let peak = 0
      for (const target of [doc, win]) {
        const add = target.addEventListener
        const remove = target.removeEventListener
        vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
          if (!listener) {
            return
          }
          const wrapped: EventListener = (event) => {
            callbacks++
            if (typeof listener === 'function') {
              listener.call(target, event)
            } else {
              listener.handleEvent(event)
            }
          }
          records.push({ target, type, original: listener, wrapped })
          peak = Math.max(peak, records.length)
          add.call(target, type, wrapped, options)
        })
        vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
          const index = records.findIndex(
            (r) => r.target === target && r.type === type && r.original === listener
          )
          const record = records[index]
          if (record) {
            records.splice(index, 1)
            remove.call(target, type, record.wrapped, options)
          } else {
            remove.call(target, type, listener, options)
          }
        })
      }
      const inactive = Array.from({ length: n }, () => mount(false))
      expect(records).toHaveLength(0)
      expect(
        inactive.every((f) => f.ownerElementHandlers === 2 && f.trackerElementHandlers === 0)
      ).toBe(true)
      for (const f of inactive) {
        f.element.dispatchEvent(mouse('mousedown'))
      }
      expect(callbacks).toBe(0)
      expect(inactive.every((f) => f.writes.length === 1)).toBe(true)
      const active = mount()
      expect(active.ownerElementHandlers).toBe(2)
      expect(active.trackerElementHandlers).toBe(1)
      expect(active.element.ownerDocument).toBe(doc)
      expect(records).toHaveLength(3)
      active.element.dispatchEvent(mouse('mousedown'))
      doc.dispatchEvent(mouse('mousemove', { clientX: 20 }))
      expect(active.writes).toEqual([DOWN])
      expect(records.length).toBeLessThanOrEqual(6)
      await release(active.element)
      expect(active.writes).toEqual([DOWN, UP])
      expect(peak).toBeLessThanOrEqual(11)
      expect(callbacks).toBeGreaterThan(0)
      expect(callbacks).toBeLessThanOrEqual(12)
      disposers
        .splice(0)
        .toReversed()
        .forEach((dispose) => dispose())
      expect(records).toHaveLength(0)
      callbacks = 0
      doc.dispatchEvent(mouse('mousemove'))
      win.dispatchEvent(new Event('blur'))
      expect(callbacks).toBe(0)
    }
  )
})

it('keeps the committed disposition through synchronous dispose before xterm reports the same release', () => {
  const f = mount()
  const effect = vi.fn(() => f.owner.dispose())
  f.element.addEventListener('mouseup', (event) => {
    expect(f.owner.commitPointer(event, 'url:1:1:20', effect)).toBe(true)
    f.owner.handlePtyInput(UP, f.forward, true)
  })
  f.element.dispatchEvent(mouse('mousedown'))
  f.element.dispatchEvent(mouse('mouseup'))
  expect(effect).toHaveBeenCalledOnce()
  expect(f.writes).toEqual([])
})
