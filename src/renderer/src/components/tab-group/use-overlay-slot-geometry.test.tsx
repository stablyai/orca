/** @vitest-environment happy-dom */
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOverlaySlotGeometry } from './use-overlay-slot-geometry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function createRect({
  top = 0,
  left = 0,
  width = 800,
  height = 600
}: Partial<Pick<DOMRect, 'top' | 'left' | 'width' | 'height'>> = {}): DOMRect {
  return {
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({})
  }
}

type GeometryProbe = {
  measuredRect: { top: number; left: number; width: number; height: number } | null
  forceMeasured: boolean
  useCssAnchors: boolean
}

let host: HTMLDivElement
let root: Root
let lastProbe: GeometryProbe | null
let resizeCallbacks: ResizeObserverCallback[]
let mutationCallbacks: MutationCallback[]
let observedElements: Element[]
let disconnectedResize = 0
let disconnectedMutation = 0

class CapturingResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback)
  }
  observe(target: Element): void {
    if (!observedElements.includes(target)) {
      observedElements.push(target)
    }
  }
  unobserve(target: Element): void {
    observedElements = observedElements.filter((el) => el !== target)
  }
  disconnect(): void {
    disconnectedResize += 1
    observedElements = []
  }
}

class CapturingMutationObserver {
  constructor(callback: MutationCallback) {
    mutationCallbacks.push(callback)
  }
  observe(): void {}
  disconnect(): void {
    disconnectedMutation += 1
  }
}

function GeometryHarness({
  groupId,
  worktreeId,
  isVisible = true,
  cssAnchorsSupported = true
}: {
  groupId: string | undefined
  worktreeId?: string
  isVisible?: boolean
  cssAnchorsSupported?: boolean
}): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const geometry = useOverlaySlotGeometry({
    overlayRef,
    groupId,
    worktreeId,
    cssAnchorsSupported,
    isVisible
  })
  lastProbe = geometry
  return <div ref={overlayRef} data-testid="overlay" />
}

function renderHarness(props: {
  groupId: string | undefined
  worktreeId?: string
  isVisible?: boolean
  cssAnchorsSupported?: boolean
}): void {
  act(() => {
    root.render(
      <GeometryHarness
        groupId={props.groupId}
        worktreeId={props.worktreeId}
        isVisible={props.isVisible}
        cssAnchorsSupported={props.cssAnchorsSupported}
      />
    )
  })
}

function mountBody(groupId: string, worktreeId: string, rect: DOMRect): HTMLElement {
  const body = document.createElement('div')
  body.dataset.tabGroupBodyId = groupId
  body.dataset.worktreeId = worktreeId
  body.getBoundingClientRect = () => rect
  document.body.appendChild(body)
  return body
}

beforeEach(() => {
  lastProbe = null
  resizeCallbacks = []
  mutationCallbacks = []
  observedElements = []
  disconnectedResize = 0
  disconnectedMutation = 0
  vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
  vi.stubGlobal('MutationObserver', CapturingMutationObserver)
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: FrameRequestCallback): number => {
      cb(0)
      return 1
    }
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())

  host = document.createElement('div')
  host.getBoundingClientRect = () => createRect({ width: 1000, height: 800 })
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  document.querySelectorAll('[data-tab-group-body-id]').forEach((el) => el.remove())
  vi.unstubAllGlobals()
})

describe('useOverlaySlotGeometry late body attach', () => {
  it('measures after a worktree body mounts late (post effect setup)', () => {
    renderHarness({ groupId: 'g-late', worktreeId: 'wt-1', cssAnchorsSupported: false })
    expect(lastProbe?.measuredRect).toBeNull()

    const body = mountBody(
      'g-late',
      'wt-1',
      createRect({ top: 40, left: 100, width: 400, height: 500 })
    )
    act(() => {
      mutationCallbacks[0]?.([], {} as MutationObserver)
    })

    expect(observedElements).toContain(body)
    expect(lastProbe?.measuredRect).toEqual({
      top: 40,
      left: 100,
      width: 400,
      height: 500
    })
  })

  it('re-observes a replaced body and drops the old observation', () => {
    const first = mountBody(
      'g-rep',
      'wt-1',
      createRect({ top: 10, left: 0, width: 300, height: 400 })
    )
    renderHarness({ groupId: 'g-rep', worktreeId: 'wt-1', cssAnchorsSupported: false })
    expect(observedElements).toContain(first)

    first.remove()
    const second = mountBody(
      'g-rep',
      'wt-1',
      createRect({ top: 20, left: 50, width: 350, height: 450 })
    )
    act(() => {
      mutationCallbacks[0]?.([], {} as MutationObserver)
    })

    expect(observedElements).toContain(second)
    expect(observedElements).not.toContain(first)
    expect(lastProbe?.measuredRect).toEqual({
      top: 20,
      left: 50,
      width: 350,
      height: 450
    })
  })

  it('does not observe another worktree body with the same group id', () => {
    const foreign = mountBody(
      'g-scope',
      'wt-foreign',
      createRect({ top: 0, left: 0, width: 900, height: 700 })
    )
    renderHarness({ groupId: 'g-scope', worktreeId: 'wt-1', cssAnchorsSupported: false })
    act(() => {
      mutationCallbacks[0]?.([], {} as MutationObserver)
    })
    expect(observedElements).not.toContain(foreign)
    expect(lastProbe?.measuredRect).toBeNull()

    const local = mountBody(
      'g-scope',
      'wt-1',
      createRect({ top: 30, left: 10, width: 200, height: 300 })
    )
    act(() => {
      mutationCallbacks[0]?.([], {} as MutationObserver)
    })
    expect(observedElements).toContain(local)
    expect(lastProbe?.measuredRect?.width).toBe(200)
  })

  it('disconnects observers on unmount', () => {
    mountBody('g-clean', 'wt-1', createRect({ width: 100, height: 100 }))
    renderHarness({ groupId: 'g-clean', worktreeId: 'wt-1', cssAnchorsSupported: false })
    expect(disconnectedResize).toBe(0)

    act(() => {
      root.unmount()
    })
    expect(disconnectedResize).toBeGreaterThanOrEqual(1)
    expect(disconnectedMutation).toBeGreaterThanOrEqual(1)
  })

  it('resets forceMeasured when the group identity changes', () => {
    const bodyA = mountBody(
      'g-a',
      'wt-1',
      createRect({ top: 40, left: 500, width: 500, height: 760 })
    )
    // Desync: overlay full size vs body half — requires css anchors path.
    renderHarness({ groupId: 'g-a', worktreeId: 'wt-1', cssAnchorsSupported: true })
    const overlay = host.querySelector('[data-testid="overlay"]') as HTMLElement
    overlay.getBoundingClientRect = () => createRect({ width: 1000, height: 800 })

    act(() => {
      resizeCallbacks[0]?.([], {} as ResizeObserver)
    })
    expect(lastProbe?.forceMeasured).toBe(true)

    // Align overlay before identity change so reset is not immediately re-latched.
    const matched = createRect({ top: 40, left: 0, width: 500, height: 760 })
    overlay.getBoundingClientRect = () => matched
    mountBody('g-b', 'wt-1', matched)
    bodyA.remove()
    renderHarness({ groupId: 'g-b', worktreeId: 'wt-1', cssAnchorsSupported: true })
    expect(lastProbe?.forceMeasured).toBe(false)
  })

  it('keeps forceMeasured across hide/reveal (isVisible must not clear the latch)', () => {
    const bodyRect = createRect({ top: 40, left: 500, width: 500, height: 760 })
    mountBody('g-vis', 'wt-1', bodyRect)
    renderHarness({
      groupId: 'g-vis',
      worktreeId: 'wt-1',
      isVisible: true,
      cssAnchorsSupported: true
    })
    const overlay = host.querySelector('[data-testid="overlay"]') as HTMLElement
    overlay.getBoundingClientRect = () => createRect({ width: 1000, height: 800 })

    act(() => {
      resizeCallbacks[0]?.([], {} as ResizeObserver)
    })
    expect(lastProbe?.forceMeasured).toBe(true)
    expect(lastProbe?.useCssAnchors).toBe(false)

    // Hide then reveal without group/worktree change — latch must survive.
    renderHarness({
      groupId: 'g-vis',
      worktreeId: 'wt-1',
      isVisible: false,
      cssAnchorsSupported: true
    })
    expect(lastProbe?.forceMeasured).toBe(true)
    expect(lastProbe?.useCssAnchors).toBe(false)

    renderHarness({
      groupId: 'g-vis',
      worktreeId: 'wt-1',
      isVisible: true,
      cssAnchorsSupported: true
    })
    expect(lastProbe?.forceMeasured).toBe(true)
    expect(lastProbe?.useCssAnchors).toBe(false)
  })
})

describe('useOverlaySlotGeometry render purity', () => {
  it('does not throw when state updates only from effects (no render-phase latch)', () => {
    // Why: React Doctor forbids ref.current writes during render; this harness
    // would surface effect/render loop errors if latch sync ran in render.
    expect(() => {
      renderHarness({ groupId: 'g-pure', worktreeId: 'wt-1', cssAnchorsSupported: true })
      renderHarness({ groupId: 'g-pure', worktreeId: 'wt-1', cssAnchorsSupported: true })
    }).not.toThrow()
  })
})
