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

function spriteAnimationPlayState(container: HTMLElement): string | undefined {
  return Array.from(container.querySelectorAll('div')).find(
    (div) => div.style.backgroundImage !== ''
  )?.style.animationPlayState
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

    // Baseline: the live idle row animates.
    expect(spriteAnimationPlayState(container)).toBe('running')

    // Grab and hold still: snap to frame 0 of the live state and freeze there.
    firePointer(wrapper, 'pointerdown', 50, 50)
    expect(spriteAnimationPlayState(container)).toBe('paused')

    // A sub-4px twitch stays frozen (deadzone).
    firePointer(wrapper, 'pointermove', 52, 51)
    expect(spriteAnimationPlayState(container)).toBe('paused')

    // Drag horizontally past the 4px deadzone: the running row animates.
    firePointer(wrapper, 'pointermove', 60, 51)
    expect(spriteAnimationPlayState(container)).toBe('running')

    // Release restores the live agent state and resumes animating.
    firePointer(wrapper, 'pointerup', 60, 51)
    expect(spriteAnimationPlayState(container)).toBe('running')
  })
})
