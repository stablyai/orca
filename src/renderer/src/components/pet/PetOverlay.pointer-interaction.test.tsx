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

// Key resolved row/frame count plus grab generation so real track changes and same-row grabs restart, but fallbacks do not.
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

    // Per-frame idle durations use step-end; uniform pacing uses steps().
    expect(spriteDiv(container).style.animationPlayState).toBe('running')
    expect(spriteDiv(container).style.animation).toContain('step-end')
    const idleName = animationName(container)

    // Stationary grab restarts frame 0 and pauses the live idle track.
    firePointer(wrapper, 'pointerdown', 50, 50)
    expect(spriteDiv(container).style.animationPlayState).toBe('paused')
    expect(spriteDiv(container).style.animation).toContain('step-end')
    expect(animationName(container)).not.toBe(idleName)
    const heldName = animationName(container)

    firePointer(wrapper, 'pointermove', 52, 51)
    expect(spriteDiv(container).style.animationPlayState).toBe('paused')

    firePointer(wrapper, 'pointermove', 52, 80)
    expect(spriteDiv(container).style.animationPlayState).toBe('paused')

    // Horizontal travel past the deadzone selects the running track and a fresh timeline.
    firePointer(wrapper, 'pointermove', 70, 80)
    expect(spriteDiv(container).style.animationPlayState).toBe('running')
    expect(spriteDiv(container).style.animation).toContain('steps(8)')
    expect(animationName(container)).not.toBe(heldName)

    // Release resumes the held-idle timeline rather than minting another generation.
    firePointer(wrapper, 'pointerup', 70, 80)
    expect(spriteDiv(container).style.animationPlayState).toBe('running')
    expect(spriteDiv(container).style.animation).toContain('step-end')
    expect(animationName(container)).toBe(heldName)
  })
})
