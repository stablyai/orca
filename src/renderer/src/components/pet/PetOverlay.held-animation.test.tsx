// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  agentStatusByPaneKey: {} as Record<string, { state: string; updatedAt: number }>,
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

// A Codex-shaped sprite: the app-state rows burst three times and then rest on
// idle, exactly as `codex-rs/tui/src/pets/model.rs` builds them.
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
        jumping: {
          row: 4,
          frames: 5,
          frameDurationsMs: [140, 140, 140, 140, 280],
          repeat: 3,
          settleTo: 'idle'
        },
        running: {
          row: 7,
          frames: 6,
          frameDurationsMs: [120, 120, 120, 120, 120, 220],
          repeat: 3,
          settleTo: 'idle'
        }
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

function spriteAnimation(container: HTMLElement): string {
  const div = Array.from(container.querySelectorAll('div')).find(
    (candidate) => candidate.style.backgroundImage !== ''
  )
  if (!div) {
    throw new Error('sprite div not found')
  }
  return div.style.animation
}

function firePointer(target: Element, type: string): void {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { button: 0, pointerId: 1, bubbles: true }))
  })
}

describe('PetOverlay pointer-held animations', () => {
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

  it('loops a hovered row instead of settling, then settles again on release', () => {
    ;({ container, root } = renderPetOverlay())
    const wrapper = container.querySelector('.pointer-events-auto')
    if (!wrapper) {
      throw new Error('draggable wrapper not found')
    }

    // Idle is not an app state, so it just loops. React synthesizes
    // onPointerEnter/Leave from pointerover/pointerout.
    expect(spriteAnimation(container)).toContain('6.6s step-end infinite')

    // Hover holds `jumping`. Codex settles an app state because the state fires
    // once; a held pointer must keep the row playing, so no burst/rest pair.
    firePointer(wrapper, 'pointerover')
    const hovered = spriteAnimation(container)
    expect(hovered).toContain('0.84s step-end infinite')
    expect(hovered).not.toContain('-burst')
    expect(hovered).not.toContain('-rest')

    firePointer(wrapper, 'pointerout')
    expect(spriteAnimation(container)).toContain('6.6s step-end infinite')
  })

  it('replays the burst only on a state change, resuming after pointer overrides', () => {
    // Only Date is faked. Faking timers too would stall React's scheduler.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000_000)
      ;({ container, root } = renderPetOverlay())
      expect(spriteAnimation(container)).toContain('6.6s step-end infinite')

      // The agent starts working: a genuine state change plays the burst.
      vi.setSystemTime(1_005_000)
      storeState.agentStatusByPaneKey = { pane: { state: 'working', updatedAt: 1_005_000 } }
      act(() => root?.render(<PetOverlay />))
      expect(spriteAnimation(container)).toContain('-burst 2.46s step-end 0s 1')

      // Hover 10s later, then leave. The state never changed, so the re-minted
      // track must resume past the burst rather than replay it.
      vi.setSystemTime(1_015_000)
      const wrapper = container.querySelector('.pointer-events-auto')
      if (!wrapper) {
        throw new Error('draggable wrapper not found')
      }
      firePointer(wrapper, 'pointerover')
      expect(spriteAnimation(container)).toContain('0.84s step-end infinite')
      firePointer(wrapper, 'pointerout')
      const resumed = spriteAnimation(container)
      expect(resumed).toContain('-burst 2.46s step-end -2.46s 1')
      expect(resumed).toContain('-rest 6.6s step-end -7.54s infinite')
    } finally {
      storeState.agentStatusByPaneKey = {}
      vi.useRealTimers()
    }
  })
})
