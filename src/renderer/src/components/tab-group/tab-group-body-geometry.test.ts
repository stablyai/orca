// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerTabGroupBody, subscribeTabGroupBodyRect } from './tab-group-body-geometry'

type FakeObserver = {
  callback: () => void
  observed: Set<Element>
  disconnected: boolean
}

let observers: FakeObserver[]
let cleanups: (() => void)[]

function element(rect: DOMRect): HTMLDivElement {
  const node = document.createElement('div')
  node.getBoundingClientRect = () => rect
  return node
}

function track(cleanup: () => void): () => void {
  cleanups.push(cleanup)
  return cleanup
}

function resizeListenerDelta(
  add: ReturnType<typeof vi.spyOn>,
  remove: ReturnType<typeof vi.spyOn>
) {
  const count = (spy: ReturnType<typeof vi.spyOn>): number =>
    spy.mock.calls.filter(([type]) => type === 'resize').length
  return count(add) - count(remove)
}

beforeEach(() => {
  observers = []
  cleanups = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly record: FakeObserver
      constructor(callback: () => void) {
        this.record = { callback, observed: new Set(), disconnected: false }
        observers.push(this.record)
      }
      observe(target: Element): void {
        this.record.observed.add(target)
      }
      unobserve(target: Element): void {
        this.record.observed.delete(target)
      }
      disconnect(): void {
        this.record.disconnected = true
        this.record.observed.clear()
      }
    }
  )
})

afterEach(() => {
  cleanups.forEach((cleanup) => cleanup())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('subscribeTabGroupBodyRect', () => {
  it('shares one observer per group and one window listener across groups', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const container = element(new DOMRect(0, 10, 800, 600))
    track(registerTabGroupBody('a', element(new DOMRect(0, 42, 400, 568))))
    track(registerTabGroupBody('b', element(new DOMRect(400, 42, 400, 568))))

    const first = vi.fn()
    const second = vi.fn()
    const other = vi.fn()
    const unsubscribeFirst = subscribeTabGroupBodyRect('a', container, first)
    const unsubscribeSecond = subscribeTabGroupBodyRect('a', container, second)
    const unsubscribeOther = subscribeTabGroupBodyRect('b', container, other)

    expect(observers).toHaveLength(2)
    expect(resizeListenerDelta(add, remove)).toBe(1)
    expect(first).toHaveBeenLastCalledWith({ top: 32, left: 0, width: 400, height: 568 })
    expect(second.mock.lastCall?.[0]).toBe(first.mock.lastCall?.[0])
    expect(other).toHaveBeenLastCalledWith({ top: 32, left: 400, width: 400, height: 568 })

    unsubscribeFirst()
    expect(observers[0].disconnected).toBe(false)
    unsubscribeSecond()
    expect(observers[0].disconnected).toBe(true)
    expect(resizeListenerDelta(add, remove)).toBe(1)
    unsubscribeOther()
    expect(observers[1].disconnected).toBe(true)
    expect(resizeListenerDelta(add, remove)).toBe(0)
  })

  it('notifies only on changes larger than a pixel', () => {
    const container = element(new DOMRect(0, 0, 800, 600))
    let bodyRect = new DOMRect(0, 32, 400, 568)
    const body = element(bodyRect)
    body.getBoundingClientRect = () => bodyRect
    track(registerTabGroupBody('a', body))
    const listener = vi.fn()
    track(subscribeTabGroupBodyRect('a', container, listener))
    listener.mockClear()

    bodyRect = new DOMRect(0, 32.5, 400.5, 568)
    window.dispatchEvent(new Event('resize'))
    expect(listener).not.toHaveBeenCalled()

    bodyRect = new DOMRect(0, 32, 380, 568)
    observers[0].callback()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({ top: 32, left: 0, width: 380, height: 568 })
  })

  it('follows the group body as it mounts, is replaced, and unmounts', () => {
    const container = element(new DOMRect(0, 0, 800, 600))
    const listener = vi.fn()
    track(subscribeTabGroupBodyRect('a', container, listener))
    expect(listener).toHaveBeenLastCalledWith(null)

    const firstBody = element(new DOMRect(0, 32, 400, 568))
    const unregisterFirst = registerTabGroupBody('a', firstBody)
    expect(observers[0].observed.has(firstBody)).toBe(true)
    expect(listener).toHaveBeenLastCalledWith({ top: 32, left: 0, width: 400, height: 568 })

    const secondBody = element(new DOMRect(0, 32, 600, 568))
    const unregisterSecond = track(registerTabGroupBody('a', secondBody))
    expect(observers[0].observed.has(firstBody)).toBe(false)
    expect(observers[0].observed.has(secondBody)).toBe(true)
    expect(listener).toHaveBeenLastCalledWith({ top: 32, left: 0, width: 600, height: 568 })

    // A late unregister from the replaced panel must not drop the live body.
    unregisterFirst()
    expect(observers[0].observed.has(secondBody)).toBe(true)

    unregisterSecond()
    expect(observers[0].observed.has(secondBody)).toBe(false)
    expect(listener).toHaveBeenLastCalledWith(null)
  })
})
