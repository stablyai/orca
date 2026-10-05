// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getNativeViewOcclusionSnapshot,
  isNativeViewOccluded,
  isNativeViewPointOccluded,
  registerNativeViewOcclusionElement,
  registerNativeViewWindowOcclusion,
  subscribeNativeViewOcclusion
} from './native-view-occlusion'

class TrackingResizeObserver {
  static created = 0
  static disconnected = 0
  constructor(_callback: ResizeObserverCallback) {
    TrackingResizeObserver.created += 1
  }
  observe(): void {}
  disconnect(): void {
    TrackingResizeObserver.disconnected += 1
  }
}

function element(rect: () => DOMRect): HTMLDivElement {
  const node = document.createElement('div')
  document.body.append(node)
  Object.defineProperty(node, 'getBoundingClientRect', { value: rect })
  return node
}

describe('native view occlusion registry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
    TrackingResizeObserver.created = 0
    TrackingResizeObserver.disconnected = 0
  })

  it('keeps one measurement loop through registration churn and stops it on teardown', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let next = 1
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = next++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
    const releaseRetained = registerNativeViewOcclusionElement(
      element(() => new DOMRect(1, 2, 3, 4))
    )
    const releaseSecondary = registerNativeViewOcclusionElement(
      element(() => new DOMRect(5, 6, 7, 8))
    )
    const pendingAfterRegister = frames.size
    releaseSecondary()
    const pendingAfterRelease = frames.size
    unsubscribe()
    const pendingAfterTeardown = frames.size
    releaseRetained()

    expect(pendingAfterRegister).toBeLessThanOrEqual(1)
    expect(pendingAfterRelease).toBeLessThanOrEqual(1)
    expect(pendingAfterTeardown).toBe(0)
  })

  it('publishes a connected element rectangle and clears it on release', () => {
    const node = element(() => new DOMRect(10, 20, 30, 40))
    const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
    const release = registerNativeViewOcclusionElement(node)
    expect(getNativeViewOcclusionSnapshot().rectangles).toEqual([
      { left: 10, top: 20, width: 30, height: 40 }
    ])
    expect(
      isNativeViewOccluded(
        { left: 35, top: 30, width: 10, height: 10 },
        getNativeViewOcclusionSnapshot()
      )
    ).toBe(true)
    expect(isNativeViewPointOccluded(10, 20, getNativeViewOcclusionSnapshot())).toBe(true)
    release()
    expect(getNativeViewOcclusionSnapshot().rectangles).toEqual([])
    unsubscribe()
  })

  it('tracks window-wide blockers independently', () => {
    const release = registerNativeViewWindowOcclusion()
    expect(getNativeViewOcclusionSnapshot().windowBlocked).toBe(true)
    release()
    expect(getNativeViewOcclusionSnapshot().windowBlocked).toBe(false)
  })

  it('does not measure or attach observers until a subscriber arrives, then tears them down', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let next = 1
    vi.stubGlobal('ResizeObserver', TrackingResizeObserver)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = next++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const release = registerNativeViewOcclusionElement(element(() => new DOMRect(1, 2, 3, 4)))
    expect(TrackingResizeObserver.created).toBe(0)
    expect(frames.size).toBe(0)
    const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
    expect(TrackingResizeObserver.created).toBe(1)
    expect(frames.size).toBe(1)
    unsubscribe()
    expect(TrackingResizeObserver.disconnected).toBe(1)
    expect(frames.size).toBe(0)
    release()
  })

  it('publishes transform-only movement on a stepped animation frame without changing size', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let next = 1
    let left = 10
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = next++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
    const release = registerNativeViewOcclusionElement(element(() => new DOMRect(left, 20, 30, 40)))
    left = 90
    const entry = frames.entries().next().value
    if (!entry) {
      throw new Error('Expected scheduled occlusion measurement')
    }
    const [id, callback] = entry
    frames.delete(id)
    callback(1)
    expect(getNativeViewOcclusionSnapshot().rectangles).toEqual([
      { left: 90, top: 20, width: 30, height: 40 }
    ])
    release()
    unsubscribe()
  })

  it('does not allow hidden, disconnected, zero-area, or duplicate geometry to widen occlusion', () => {
    const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
    const visible = element(() => new DOMRect(1, 2, 3, 4))
    const duplicate = element(() => new DOMRect(1, 2, 3, 4))
    const zero = element(() => new DOMRect(0, 0, 0, 4))
    const hiddenWindow = element(() => new DOMRect(0, 0, 0, 0))
    const releases = [
      registerNativeViewOcclusionElement(visible),
      registerNativeViewOcclusionElement(duplicate),
      registerNativeViewOcclusionElement(zero),
      registerNativeViewOcclusionElement(hiddenWindow, { windowWide: true })
    ]
    expect(getNativeViewOcclusionSnapshot().rectangles).toEqual([
      { left: 1, top: 2, width: 3, height: 4 }
    ])
    expect(getNativeViewOcclusionSnapshot().windowBlocked).toBe(false)
    visible.remove()
    const explicit = registerNativeViewWindowOcclusion()
    expect(getNativeViewOcclusionSnapshot().windowBlocked).toBe(true)
    explicit()
    for (const release of releases) {
      release()
    }
    unsubscribe()
  })

  it('keeps the second global blocker effective when the first cleanup repeats', () => {
    const first = registerNativeViewWindowOcclusion()
    const second = registerNativeViewWindowOcclusion()
    expect(getNativeViewOcclusionSnapshot().windowBlocked).toBe(true)

    first()
    first()
    expect(getNativeViewOcclusionSnapshot().windowBlocked).toBe(true)

    second()
    expect(getNativeViewOcclusionSnapshot().windowBlocked).toBe(false)
  })
})
