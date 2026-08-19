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
  } as { url: string; ready: boolean; sprite: null; detected: null; heldUrl?: string }
}))

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

vi.mock('./usePetUrl', () => ({ usePetUrl: () => petUrlMock.current }))

import { PetOverlay } from './PetOverlay'

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
})
