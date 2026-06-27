// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DetectedSpriteCacheEntry } from './pet-blob-cache'
import type { CustomPet } from '../../../../shared/types'

type PetUrlState =
  | { url: string; ready: boolean; sprite: null; detected: null }
  | {
      url: string
      ready: boolean
      sprite: NonNullable<CustomPet['sprite']>
      detected: null
    }
  | { url: string; ready: boolean; sprite: null; detected: DetectedSpriteCacheEntry }

const defaultPetUrlState: PetUrlState = {
  url: 'data:image/png;base64,',
  ready: true,
  sprite: null,
  detected: null
}

const petUrlMock = vi.hoisted(() => ({
  current: {
    url: 'data:image/png;base64,',
    ready: true,
    sprite: null,
    detected: null
  } as PetUrlState
}))

// Why: keep the render focused on the overlay's layout structure — the real
// store + pet-url resolution pull in IPC/asset loading we don't need to assert
// the hit-area invariant.
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
  usePetUrl: () => petUrlMock.current
}))

import { PetOverlay } from './PetOverlay'

function renderOverlay(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<PetOverlay />)
  })
  return { root, container }
}

function setPetUrlState(state: PetUrlState): void {
  petUrlMock.current = state
}

function getDragHandle(container: HTMLElement): HTMLElement {
  const fixedEl = container.querySelector('.fixed')
  const sizeFullEl = container.querySelector('.size-full')
  const grabEls = container.querySelectorAll('.pointer-events-auto')

  expect(fixedEl).not.toBeNull()
  expect(sizeFullEl).not.toBeNull()
  // Exactly one element opts into pointer events: the content-fit grab handle.
  expect(grabEls.length).toBe(1)
  const grabEl = grabEls[0] as HTMLElement

  // The outer box and the size-full middle layer must stay pointer-events-none
  // so they never become a grab surface around the rendered pet.
  expect(fixedEl?.className).toContain('pointer-events-none')
  expect(sizeFullEl?.className).toContain('pointer-events-none')
  expect(sizeFullEl?.className).not.toContain('pointer-events-auto')

  // The grab handle (the element carrying the pointer handlers) is NOT the
  // full-size box: it does not carry size-full and sits nested inside it.
  expect(grabEl.className).not.toContain('size-full')
  expect(grabEl).not.toBe(sizeFullEl)
  expect(sizeFullEl?.contains(grabEl)).toBe(true)

  // The drag affordances (cursor + touch-action) live on that same handle,
  // confirming it is the pointer-handler element rather than the box.
  expect(grabEl.style.cursor).toBe('grab')
  expect(grabEl.style.touchAction).toBe('none')

  return grabEl
}

describe('PetOverlay drag hit area', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    setPetUrlState(defaultPetUrlState)
  })

  it('keeps the grab/drag region off the full-size square box', () => {
    ;({ root, container } = renderOverlay())

    const grabEl = getDragHandle(container)
    const img = grabEl.querySelector('img') as HTMLImageElement | null
    expect(img).not.toBeNull()
    expect(img?.style.maxWidth).toBe('180px')
    expect(img?.style.maxHeight).toBe('180px')
  })

  it('renders manifest sprites with a content-sized drag handle child', () => {
    setPetUrlState({
      url: 'data:image/png;base64,',
      ready: true,
      sprite: {
        frameWidth: 252,
        frameHeight: 320,
        columns: 4,
        rows: 1,
        sheetWidth: 1008,
        sheetHeight: 320,
        fps: 8,
        defaultAnimation: 'idle',
        animations: { idle: { row: 0, frames: 4 } }
      },
      detected: null
    })

    ;({ root, container } = renderOverlay())

    const grabEl = getDragHandle(container)
    const spriteEl = grabEl.querySelector('div[style*="background-image"]') as HTMLElement | null
    expect(spriteEl).not.toBeNull()
    expect(spriteEl?.style.width).toBe('141.75px')
    expect(spriteEl?.style.height).toBe('180px')
  })

  it('renders detected sprites with a fixed content footprint smaller than the square box', () => {
    setPetUrlState({
      url: 'data:image/png;base64,',
      ready: true,
      sprite: null,
      detected: {
        frames: [
          { x: 0, y: 0, w: 252, h: 320 },
          { x: 0, y: 0, w: 126, h: 320 }
        ],
        bitmaps: [] as ImageBitmap[],
        fps: 8
      }
    })

    ;({ root, container } = renderOverlay())

    const grabEl = getDragHandle(container)
    const canvas = grabEl.querySelector('canvas') as HTMLCanvasElement | null
    expect(canvas).not.toBeNull()
    expect(canvas?.style.width).toBe('142px')
    expect(canvas?.style.height).toBe('180px')
  })
})
