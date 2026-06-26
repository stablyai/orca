// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  usePetUrl: () => ({
    url: 'data:image/png;base64,',
    ready: true,
    sprite: null,
    detected: null
  })
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
  })

  it('keeps the grab/drag region off the full-size square box', () => {
    ;({ root, container } = renderOverlay())

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
  })
})
