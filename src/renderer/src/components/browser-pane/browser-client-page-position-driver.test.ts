// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRetainedHostFixture,
  disposeRetainedHostFixtures,
  RETAINED_FIXTURE_PAGE
} from './browser-client-page-retained-host-fixture'
import type { BrowserClientPageVisibleAttachment } from './browser-client-page-retained-registry'

/** Drives the shared loop by hand so a "frame" is an explicit step, not wall-clock timing. */
type FrameStub = {
  pending: () => number
  runFrame: () => void
  cancelled: () => number[]
}

let frames: FrameStub
let openAttachments: BrowserClientPageVisibleAttachment[]
let visibilityState: DocumentVisibilityState

function installFrameStub(): FrameStub {
  const scheduled = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  let nextId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextId += 1
    scheduled.set(nextId, callback)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelled.push(id)
    scheduled.delete(id)
  })
  return {
    pending: () => scheduled.size,
    cancelled: () => cancelled,
    runFrame: () => {
      for (const [id, callback] of Array.from(scheduled)) {
        scheduled.delete(id)
        callback(0)
      }
    }
  }
}

function setVisibility(next: DocumentVisibilityState): void {
  visibilityState = next
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Moves a pane the way a split resize or sidebar toggle does: new rect, no resize/scroll event. */
function moveContainer(container: HTMLElement, left: number, top: number): void {
  container.getBoundingClientRect = () =>
    ({ left, top, width: 400, height: 300 }) as unknown as DOMRect
}

async function attachHost(
  browserPageId: string,
  left: number
): Promise<{ container: HTMLElement; host: () => HTMLDivElement }> {
  const identity = { ...RETAINED_FIXTURE_PAGE, browserPageId }
  const rig = createRetainedHostFixture()
  moveContainer(rig.container, left, 0)
  await rig.mount(identity)
  openAttachments.push(rig.attach(identity))
  return {
    container: rig.container,
    host: () =>
      document.querySelector<HTMLDivElement>(
        `[data-browser-client-page-id="${browserPageId}"]`
      ) as HTMLDivElement
  }
}

beforeEach(() => {
  openAttachments = []
  visibilityState = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState
  })
  frames = installFrameStub()
})

afterEach(() => {
  for (const attachment of openAttachments.splice(0)) {
    attachment.detach()
  }
  disposeRetainedHostFixtures()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('client-hosted page position driver', () => {
  it('runs one shared frame for two attached hosts instead of one loop each', async () => {
    const first = await attachHost('page-one', 10)
    expect(frames.pending()).toBe(1)

    const second = await attachHost('page-two', 20)

    expect(frames.pending()).toBe(1)

    // The single callback still repositions every registered host.
    moveContainer(first.container, 111, 0)
    moveContainer(second.container, 222, 0)
    frames.runFrame()

    expect(frames.pending()).toBe(1)
    expect(first.host().style.left).toBe('111px')
    expect(second.host().style.left).toBe('222px')
  })

  it('tracks a pane that moves with no resize or scroll event', async () => {
    const pane = await attachHost('page-one', 10)
    expect(pane.host().style.left).toBe('10px')

    moveContainer(pane.container, 640, 48)
    frames.runFrame()

    expect(pane.host().style.left).toBe('640px')
    expect(pane.host().style.top).toBe('48px')
  })

  it('stops the loop while hidden and resyncs every host before resuming', async () => {
    const first = await attachHost('page-one', 10)
    const second = await attachHost('page-two', 20)

    setVisibility('hidden')

    expect(frames.pending()).toBe(0)
    expect(frames.cancelled()).toHaveLength(1)

    // A pane moved while hidden must be corrected the instant the document is observable.
    moveContainer(first.container, 300, 0)
    moveContainer(second.container, 400, 0)
    setVisibility('visible')

    expect(first.host().style.left).toBe('300px')
    expect(second.host().style.left).toBe('400px')
    expect(frames.pending()).toBe(1)
  })

  it('cancels the frame and drops the visibilitychange listener with the last host', async () => {
    const removeListener = vi.spyOn(document, 'removeEventListener')
    await attachHost('page-one', 10)
    await attachHost('page-two', 20)

    openAttachments.shift()!.detach()

    expect(frames.pending()).toBe(1)
    expect(removeListener.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(false)

    openAttachments.shift()!.detach()

    expect(frames.pending()).toBe(0)
    expect(frames.cancelled()).toHaveLength(1)
    expect(removeListener.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true)
  })
})
