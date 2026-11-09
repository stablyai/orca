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
