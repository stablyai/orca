// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const petUrlMock = vi.hoisted(() => ({
  current: {
    url: 'data:image/png;base64,idle',
    ready: true,
    sprite: null,
    detected: null
  } as {
    url: string
    ready: boolean
    sprite: null
    detected: null
    heldUrl?: string
    poses?: { url: string; frameWidth: number; frameHeight: number; frames: number; fps: number }
  }
}))

const storeMock = vi.hoisted(() => ({
  state: {
    petSize: 180,
    petWalks: true,
    petReturnsToLane: true,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    retainedAgentsByPaneKey: {}
  } as Record<string, unknown>
}))

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: unknown) => unknown) => selector(storeMock.state),
    { getState: () => storeMock.state }
  )
  return { useAppStore }
})

vi.mock('./usePetUrl', () => ({ usePetUrl: () => petUrlMock.current }))

import { PetOverlay } from './PetOverlay'
import { PET_DOWNED_MS, PET_RISING_MS } from './usePetFallToLane'

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderOverlay(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<PetOverlay />)
  })
}

function grabHandle(): HTMLElement {
  return container?.querySelector('.pointer-events-auto') as HTMLElement
}

const POSES = {
  url: 'data:image/png;base64,posesheet',
  frameWidth: 252,
  frameHeight: 320,
  frames: 4,
  fps: 8
}
// 252x320 cells scaled into a 180 box => 0.5625, so each row is 180px of offset.
const ROW_OFFSET_PX = 180

function poseSprite(): HTMLElement | null {
  return container?.querySelector('div[style*="background-image"]') as HTMLElement | null
}

function poseRow(): number {
  const y = poseSprite()?.style.backgroundPosition?.split(' ')[1] ?? '0px'
  // `|| 0` folds -0, which Object.is separates from 0.
  return Math.round(-Number.parseFloat(y) / ROW_OFFSET_PX) || 0
}

function petImage(): HTMLImageElement {
  return container?.querySelector('img') as HTMLImageElement
}

function firePointer(target: Element, type: string, clientX: number, clientY: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { clientX, clientY, button: 0, pointerId: 1, bubbles: true })
    )
  })
}

beforeEach(() => {
  storeMock.state.petWalks = true
  storeMock.state.petReturnsToLane = true
  window.localStorage.clear()
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  petUrlMock.current = {
    url: 'data:image/png;base64,idle',
    ready: true,
    sprite: null,
    detected: null
  }
})

describe('PetOverlay held pose', () => {
  it('swaps to the held artwork while the pet is in hand', () => {
    petUrlMock.current = {
      url: 'data:image/png;base64,idle',
      ready: true,
      sprite: null,
      detected: null,
      heldUrl: 'data:image/png;base64,held'
    }

    renderOverlay()
    expect(petImage().src).toContain('idle')

    firePointer(grabHandle(), 'pointerdown', 350, 600)
    expect(petImage().src).toContain('held')

    firePointer(grabHandle(), 'pointerup', 350, 600)
    expect(petImage().src).toContain('idle')
  })

  it('keeps the normal artwork for a pet that ships no held pose', () => {
    renderOverlay()

    firePointer(grabHandle(), 'pointerdown', 350, 600)

    expect(petImage().src).toContain('idle')
  })

  it('renders the pose sheet rather than a flat image', () => {
    petUrlMock.current = {
      url: 'data:image/png;base64,idle',
      ready: true,
      sprite: null,
      detected: null,
      poses: POSES
    }

    renderOverlay()

    expect(poseSprite()?.style.backgroundImage).toContain('posesheet')
    // Per-frame holds mean explicit keyframe stops, not a uniform steps().
    // The running row is 4 frames x 125ms.
    expect(poseSprite()?.style.animation).toContain('step-end')
    expect(poseSprite()?.style.animation).toContain('0.5s')
    expect(container?.querySelector('img')).toBeNull()
  })

  it('drops the pose sheet for the held artwork once picked up', () => {
    petUrlMock.current = {
      url: 'data:image/png;base64,idle',
      ready: true,
      sprite: null,
      detected: null,
      heldUrl: 'data:image/png;base64,held',
      poses: POSES
    }

    renderOverlay()
    expect(poseSprite()).not.toBeNull()

    firePointer(grabHandle(), 'pointerdown', 350, 600)

    expect(poseSprite()).toBeNull()
    expect(petImage().src).toContain('held')
  })

  it('drops the CSS bob while the sheet supplies its own bounce', () => {
    petUrlMock.current = {
      url: 'data:image/png;base64,idle',
      ready: true,
      sprite: null,
      detected: null,
      heldUrl: 'data:image/png;base64,held',
      poses: POSES
    }

    renderOverlay()

    // Two vertical oscillations at different periods read as a wobble.
    expect(grabHandle().style.animation).not.toContain('pet-bob')

    // The sway still applies in hand — that artwork is a still frame.
    firePointer(grabHandle(), 'pointerdown', 350, 600)
    expect(grabHandle().style.animation).toContain('pet-held-sway')
  })

  it('plays the locomotion row while pacing rather than the breathing idle', () => {
    petUrlMock.current = {
      url: 'data:image/png;base64,idle',
      ready: true,
      sprite: null,
      detected: null,
      poses: POSES
    }

    renderOverlay()

    // Row 1 is the walk cycle; row 0 would read as gliding in a standing pose.
    expect(poseRow()).toBe(1)
  })

  it('rests on the breathing row when the user turned pacing off', () => {
    storeMock.state.petWalks = false
    petUrlMock.current = {
      url: 'data:image/png;base64,idle',
      ready: true,
      sprite: null,
      detected: null,
      poses: POSES
    }

    renderOverlay()

    expect(poseRow()).toBe(0)
    // The toggle stops the pacing, not the pet: it must still breathe.
    expect(poseSprite()?.style.animationPlayState).toBe('running')
    // 4 frames x 420ms of breathing, far slower than the 0.5s walk.
    expect(poseSprite()?.style.animation).toContain('1.68s')
  })

  it('plays drawn fall rows instead of rotating the standing pose', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const frames = new Map<number, FrameRequestCallback>()
    let nextId = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextId++
      frames.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => void frames.delete(id))
    const step = (t: number): void => {
      const pending = [...frames.values()]
      frames.clear()
      act(() => {
        for (const cb of pending) {
          cb(t)
        }
      })
    }

    petUrlMock.current = {
      url: 'data:image/png;base64,idle',
      ready: true,
      sprite: null,
      detected: null,
      poses: POSES
    }

    renderOverlay()
    const box = container?.querySelector('.fixed') as HTMLElement
    const grab = grabHandle()

    firePointer(grab, 'pointerdown', 350, 600)
    firePointer(grab, 'pointermove', 350, 120)
    firePointer(grab, 'pointermove', 350, 120)
    firePointer(grab, 'pointerup', 350, 120)

    step(0)
    step(60)

    // Row 4 is the drawn fall; the body no longer rotates via CSS.
    expect(poseRow()).toBe(4)
    expect(grab.style.transform ?? '').not.toContain('rotate(-90deg)')

    for (let t = 120; t <= 2000 && box.style.top !== '564px'; t += 100) {
      step(t)
    }
    expect(poseRow()).toBe(5)

    act(() => {
      vi.advanceTimersByTime(PET_DOWNED_MS + 20)
    })
    expect(poseRow()).toBe(6)
    // Getting up must settle on its feet, not loop back onto the floor.
    expect(poseSprite()?.style.animation).toContain('forwards')
    expect(poseSprite()?.style.animation).not.toContain('infinite')

    act(() => {
      vi.advanceTimersByTime(PET_RISING_MS + 20)
    })
    expect(poseRow()).toBe(1)

    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
})
