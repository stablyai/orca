// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  agentStatusByPaneKey: {},
  agentStatusEpoch: 0,
  retainedAgentsByPaneKey: {},
  petSize: 180
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
    { getState: () => storeState }
  )
}))

vi.mock('./usePetUrl', () => ({
  usePetUrl: () => ({
    url: 'blob:custom-pet',
    ready: true,
    sprite: {
      frameWidth: 192,
      frameHeight: 208,
      columns: 8,
      rows: 9,
      sheetWidth: 1536,
      sheetHeight: 1872,
      fps: 8,
      defaultAnimation: 'idle',
      animations: {
        idle: { row: 0, frames: 6, frameDurationsMs: [1680, 660, 660, 840, 840, 1920] },
        'running-right': { row: 1, frames: 8 }
      }
    },
    detected: null
  })
}))

import { PetOverlay } from './PetOverlay'

function renderPetOverlay(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<PetOverlay />)
  })
  return { container, root }
}

function installLocalStorage(): void {
  const values = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value)
    }
  })
}

function spriteDiv(container: HTMLElement): HTMLDivElement {
  const div = Array.from(container.querySelectorAll('div')).find(
    (candidate) => candidate.style.backgroundImage !== ''
  )
  if (!div) {
    throw new Error('sprite div not found')
  }
  return div
}

// The @keyframes name is `pet-<useId>-<row>-<frames>-<dragGeneration>`: the
// resolved track keeps a switched-to row from reusing the prior timeline, and
// the generation suffix restarts a same-row grab from frame 0.
function animationName(container: HTMLElement): string {
  return spriteDiv(container).style.animation.split(' ')[0]
}

function firePointer(target: Element, type: string, clientX: number, clientY: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { clientX, clientY, button: 0, pointerId: 1, bubbles: true })
    )
  })
}

describe('PetOverlay grab-and-hold pointer interaction', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('freezes on a stationary grab, then animates once dragged past the deadzone', () => {
    ;({ container, root } = renderPetOverlay())
    const wrapper = container.querySelector('.pointer-events-auto')
    if (!wrapper) {
      throw new Error('draggable wrapper not found')
    }

    // Baseline: the live idle row animates (idle carries per-frame durations, so
    // it renders as step-end rather than steps()).
    expect(spriteDiv(container).style.animationPlayState).toBe('running')
    expect(spriteDiv(container).style.animation).toContain('step-end')
    const idleName = animationName(container)

    // Grab and hold still: mint a fresh restart (frame 0) and freeze there while
    // staying on the live idle row.
    firePointer(wrapper, 'pointerdown', 50, 50)
    expect(spriteDiv(container).style.animationPlayState).toBe('paused')
    expect(spriteDiv(container).style.animation).toContain('step-end')
    expect(animationName(container)).not.toBe(idleName)
    const heldName = animationName(container)

    // A sub-4px twitch stays frozen (deadzone).
    firePointer(wrapper, 'pointermove', 52, 51)
    expect(spriteDiv(container).style.animationPlayState).toBe('paused')

    // A large vertical-only move keeps the hold (no horizontal direction yet).
    firePointer(wrapper, 'pointermove', 52, 80)
    expect(spriteDiv(container).style.animationPlayState).toBe('paused')

    // Drag right past the 4px deadzone: switch to the running-right row (row 1,
    // 8 frames, no durations → steps(8)) and resume animating. The keyframes
    // name changes with the resolved row, so it starts from frame 0 rather than
    // reusing the idle timeline.
    firePointer(wrapper, 'pointermove', 70, 80)
    expect(spriteDiv(container).style.animationPlayState).toBe('running')
    expect(spriteDiv(container).style.animation).toContain('steps(8)')
    expect(animationName(container)).not.toBe(heldName)

    // Release returns to the idle row (step-end) and resumes animating. Same row
    // and generation as the grab-hold, so it's the held-idle identity again.
    firePointer(wrapper, 'pointerup', 70, 80)
    expect(spriteDiv(container).style.animationPlayState).toBe('running')
    expect(spriteDiv(container).style.animation).toContain('step-end')
    expect(animationName(container)).toBe(heldName)
  })

  it('does not restart the idle track when hover falls back to the same row', () => {
    ;({ container, root } = renderPetOverlay())
    const wrapper = container.querySelector('.pointer-events-auto')
    if (!wrapper) {
      throw new Error('draggable wrapper not found')
    }
    // The mocked sprite has no jumping row, so hover (→ jumping) resolves back to
    // idle. Keying the keyframes on the resolved row means the name must not
    // change — otherwise the unchanged idle animation restarts on hover. React
    // synthesizes onPointerEnter/Leave from pointerover/pointerout.
    const idleName = animationName(container)
    firePointer(wrapper, 'pointerover', 0, 0)
    expect(animationName(container)).toBe(idleName)
    firePointer(wrapper, 'pointerout', 0, 0)
    expect(animationName(container)).toBe(idleName)
  })
})
