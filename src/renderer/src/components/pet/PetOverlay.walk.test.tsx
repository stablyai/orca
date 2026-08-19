// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../store', () => {
  const storeState = {
    petSize: 180,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    retainedAgentsByPaneKey: {}
  }
  const useAppStore = Object.assign(
    (selector: (state: unknown) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
  return { useAppStore }
})

vi.mock('./usePetUrl', () => ({
  usePetUrl: () => ({ url: 'data:image/png;base64,', ready: true, sprite: null, detected: null })
}))

import { PetOverlay } from './PetOverlay'
import { PET_WALK_SPEED_PX_PER_SEC } from './pet-walk-lane'

let root: Root | null = null
let container: HTMLDivElement | null = null
let frameCallbacks: FrameRequestCallback[] = []

function firePointer(target: Element, type: string, clientX: number, clientY: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { clientX, clientY, button: 0, pointerId: 1, bubbles: true })
    )
  })
}

/** Runs every pending animation frame with `timestamp`, then settles React. */
function stepFrame(timestamp: number): void {
  const pending = frameCallbacks
  frameCallbacks = []
  act(() => {
    for (const callback of pending) {
      callback(timestamp)
    }
  })
}

function renderOverlay(): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<PetOverlay />)
  })
  return container.querySelector('.fixed') as HTMLElement
}

beforeEach(() => {
  window.localStorage.clear()
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
  frameCallbacks = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameCallbacks.push(callback)
    return frameCallbacks.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

describe('PetOverlay bottom lane', () => {
  it('rests the pet on the bottom lane instead of a stale persisted y', () => {
    window.localStorage.setItem('pet-overlay-position', JSON.stringify({ x: 300, y: 40 }))

    const box = renderOverlay()

    // 768 viewport - 180 pet - 24 status bar
    expect(box.style.top).toBe('564px')
    expect(box.style.left).toBe('300px')
  })

  it('walks along the lane at the configured speed', () => {
    window.localStorage.setItem('pet-overlay-position', JSON.stringify({ x: 300, y: 564 }))

    const box = renderOverlay()
    stepFrame(0)
    stepFrame(1000)

    expect(Number.parseFloat(box.style.left)).toBeCloseTo(300 + PET_WALK_SPEED_PX_PER_SEC, 5)
    expect(box.style.top).toBe('564px')
  })

  it('does not rewrite the persisted position on every walk frame', () => {
    renderOverlay()
    const setItem = vi.spyOn(window.localStorage, 'setItem')

    for (let timestamp = 0; timestamp <= 320; timestamp += 16) {
      stepFrame(timestamp)
    }

    const positionWrites = setItem.mock.calls.filter(([key]) => key === 'pet-overlay-position')
    expect(positionWrites).toHaveLength(0)
    setItem.mockRestore()
  })

  it('mirrors the pet when it turns around at the right edge', () => {
    window.localStorage.setItem('pet-overlay-position', JSON.stringify({ x: 1000, y: 564 }))

    const box = renderOverlay()
    const facing = (): HTMLElement => container?.querySelector('[data-pet-facing]') as HTMLElement

    expect(facing().dataset.petFacing).toBe('right')
    expect(facing().style.transform).toBe('')

    stepFrame(0)
    stepFrame(1000)

    // 1200 viewport - 180 pet
    expect(box.style.left).toBe('1020px')
    expect(facing().dataset.petFacing).toBe('left')
    expect(facing().style.transform).toContain('scaleX(-1)')
  })

  it('follows the pointer while held, then drops back to the lane keeping the new x', () => {
    window.localStorage.setItem('pet-overlay-position', JSON.stringify({ x: 300, y: 564 }))

    const box = renderOverlay()
    const grab = container?.querySelector('.pointer-events-auto') as HTMLElement

    firePointer(grab, 'pointerdown', 350, 600)
    firePointer(grab, 'pointermove', 600, 200)

    // Grab offset is (50, 36), so the box tracks the pointer freely off the lane.
    expect(box.style.left).toBe('550px')
    expect(box.style.top).toBe('164px')

    firePointer(grab, 'pointerup', 600, 200)

    expect(box.style.left).toBe('550px')
    expect(box.style.top).toBe('564px')
  })

  it('swaps the idle bob for a hanging sway while the pet is in hand', () => {
    renderOverlay()
    const grab = container?.querySelector('.pointer-events-auto') as HTMLElement

    expect(grab.style.animation).toContain('pet-bob')

    firePointer(grab, 'pointerdown', 350, 600)

    expect(grab.style.animation).toContain('pet-held-sway')
    expect(grab.style.animation).not.toContain('pet-bob')
    // Why: the sway must keep running while held — a paused hold reads as frozen.
    expect(grab.style.animationPlayState).toBe('running')
    // Pivot at the top edge so the body swings below the hand, not around itself.
    expect(grab.style.transformOrigin).toBe('50% 0%')

    firePointer(grab, 'pointerup', 350, 600)

    expect(grab.style.animation).toContain('pet-bob')
  })

  it('declares squash-and-stretch in the held sway keyframes', () => {
    renderOverlay()
    const css = Array.from(container?.querySelectorAll('style') ?? [])
      .map((node) => node.textContent ?? '')
      .join('\n')

    expect(css).toContain('@keyframes pet-held-sway')
    expect(css).toContain('rotate(')
    expect(css).toContain('scale(')
  })

  it('seats the pet on the floor of the lane box rather than centring it', () => {
    renderOverlay()
    const laneBox = container?.querySelector('.size-full') as HTMLElement

    // Feet on the status bar, and centred so the walk reaches both edges evenly.
    expect(laneBox.className).toContain('items-end')
    expect(laneBox.className).toContain('justify-center')
    expect(laneBox.className).not.toContain('items-center')
  })

  it('holds the pet still when the user prefers reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }))
    window.localStorage.setItem('pet-overlay-position', JSON.stringify({ x: 300, y: 564 }))

    const box = renderOverlay()
    stepFrame(0)
    stepFrame(1000)

    expect(box.style.left).toBe('300px')
  })
})
