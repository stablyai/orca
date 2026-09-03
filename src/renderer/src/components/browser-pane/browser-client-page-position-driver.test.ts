// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRetainedHostFixture,
  disposeRetainedHostFixtures,
  RETAINED_FIXTURE_PAGE,
  type RetainedHostFixture
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

function breakContainer(container: HTMLElement): void {
  container.getBoundingClientRect = () => {
    throw new Error('rect read failed')
  }
}

async function attachHost(
  browserPageId: string,
  left: number
): Promise<{
  container: HTMLElement
  host: () => HTMLDivElement
  registry: RetainedHostFixture['registry']
}> {
  const identity = { ...RETAINED_FIXTURE_PAGE, browserPageId }
  const rig = createRetainedHostFixture()
  moveContainer(rig.container, left, 0)
  await rig.mount(identity)
  openAttachments.push(rig.attach(identity))
  return {
    container: rig.container,
    registry: rig.registry,
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

  // Why this is pinned: a `hidden` document is not proof the overlay is unobservable. Chromium's
  // macOS occlusion tracker can wedge `visibilityState` at 'hidden' with no further
  // visibilitychange while the window still paints, and Chromium already stops rAF itself in the
  // states where the window really is unobservable. A visibility gate here would freeze every
  // overlay on a window the user is looking at and save nothing.
  it('keeps tracking pane moves while the document reports hidden', async () => {
    const first = await attachHost('page-one', 10)
    const second = await attachHost('page-two', 20)

    setVisibility('hidden')

    expect(frames.pending()).toBe(1)
    expect(frames.cancelled()).toHaveLength(0)

    moveContainer(first.container, 300, 24)
    moveContainer(second.container, 400, 36)
    frames.runFrame()

    expect(first.host().style.left).toBe('300px')
    expect(first.host().style.top).toBe('24px')
    expect(second.host().style.left).toBe('400px')
    expect(second.host().style.top).toBe('36px')
    expect(frames.pending()).toBe(1)
  })

  it('cancels the shared frame only when the last host detaches', async () => {
    await attachHost('page-one', 10)
    await attachHost('page-two', 20)

    openAttachments.shift()!.detach()

    expect(frames.pending()).toBe(1)

    openAttachments.shift()!.detach()

    expect(frames.pending()).toBe(0)
    expect(frames.cancelled()).toHaveLength(1)
  })

  // Why this is pinned: one loop now serves every overlay, so a host that throws must not take
  // the others down with it — nothing would restart the loop, and a pane that merely moves fires
  // no resize/scroll event to recover from.
  it('keeps syncing the other hosts and reschedules when one host throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = await attachHost('page-one', 10)
    const healthy = await attachHost('page-two', 20)

    breakContainer(broken.container)
    moveContainer(healthy.container, 222, 12)
    frames.runFrame()

    expect(healthy.host().style.left).toBe('222px')
    expect(healthy.host().style.top).toBe('12px')
    expect(frames.pending()).toBe(1)

    // Still running a frame later, and the repeat failure is not re-logged every frame.
    moveContainer(healthy.container, 333, 24)
    frames.runFrame()

    expect(healthy.host().style.left).toBe('333px')
    expect(frames.pending()).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('releases a disposed registry host from the shared loop without its pane detaching', async () => {
    const pane = await attachHost('page-one', 10)

    pane.registry.dispose()

    expect(frames.pending()).toBe(0)
    expect(frames.cancelled()).toHaveLength(1)

    // The stranded sync would otherwise keep re-reading a container whose host left the document.
    moveContainer(pane.container, 999, 0)
    frames.runFrame()

    expect(pane.host()).toBeNull()
  })
})
