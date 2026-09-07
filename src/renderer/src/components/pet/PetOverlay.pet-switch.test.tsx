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

// Why: a mutable pet so a re-render can simulate switching between two cached
// custom pets that both resolve the idle state to different rows.
const petUrlState = vi.hoisted(() => ({
  url: 'blob:pet-a',
  idleRow: 0
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
    { getState: () => storeState }
  )
}))

vi.mock('./usePetUrl', () => ({
  usePetUrl: () => ({
    url: petUrlState.url,
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
      animations: { idle: { row: petUrlState.idleRow, frames: 6 } }
    },
    detected: null
  })
}))

import { PetOverlay } from './PetOverlay'

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

function spriteDiv(container: HTMLElement): HTMLDivElement | undefined {
  return Array.from(container.querySelectorAll('div')).find(
    (div) => div.style.backgroundImage !== ''
  )
}

describe('PetOverlay pet switching', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    installLocalStorage()
    petUrlState.url = 'blob:pet-a'
    petUrlState.idleRow = 0
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('remounts the sprite on a pet change so it cannot inherit the prior timeline', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<PetOverlay />))
    const before = spriteDiv(container)
    expect(before).toBeDefined()

    // Switch to a different cached pet whose idle maps to another row.
    petUrlState.url = 'blob:pet-b'
    petUrlState.idleRow = 2
    act(() => root?.render(<PetOverlay />))

    // key={url} makes React replace the element rather than update it in place;
    // a fresh element starts its CSS animation at frame 0 instead of carrying
    // the prior pet's currentTime. Without the key it would be the same node.
    const after = spriteDiv(container)
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
  })
})
