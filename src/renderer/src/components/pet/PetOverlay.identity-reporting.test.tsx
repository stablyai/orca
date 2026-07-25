// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The popout identity bug, at the level it actually broke.
 *
 * A popout is a separate renderer. Its store starts at the DEFAULT pet id with
 * an empty custom-pet list, because `petId`/`customPets` live in persisted UI
 * state that only the main window was fetching. PetOverlay reported that
 * defaulted id unconditionally, so dragging the pet into a popout published
 * "claudino" to the authority and the operator's gandalf changed species —
 * everywhere, including on the phone, since the authority is the single writer.
 *
 * The hook already ignored a null id; nothing forced the OVERLAY to pass null.
 * That gap is what these tests close.
 */

const storeState = vi.hoisted(() => ({
  agentStatusByPaneKey: {},
  agentStatusEpoch: 0,
  retainedAgentsByPaneKey: {},
  petSize: 180,
  // The defaulted value a popout's unhydrated store really holds.
  petId: 'claudino'
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
    { getState: () => storeState }
  )
}))

vi.mock('./usePetUrl', () => ({
  usePetUrl: () => ({ url: 'blob:pet', ready: true, sprite: null, detected: null })
}))

import { PetOverlay } from './PetOverlay'
import { initialPresence } from '../../../../shared/pet-presence'

const setPetId = vi.fn()

/** registerSurface's resolved value IS the snapshot the overlay renders from,
 *  so it has to be a real one rather than undefined. */
const snapshot = (): unknown => ({ presence: initialPresence(Date.now()), surfaces: [] })

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

// Roots are tracked and unmounted between tests: an abandoned root keeps
// flushing passive effects into the NEXT test's act(), which made a leaked
// mount from the previous case look like a spurious setPetId call.
let roots: Root[] = []

function render(props: Parameters<typeof PetOverlay>[0]): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<PetOverlay {...props} />)
  })
}

beforeEach(() => {
  installLocalStorage()
  setPetId.mockClear()
  storeState.petId = 'claudino'
  ;(window as unknown as { api: unknown }).api = {
    petPresence: {
      setPetId,
      registerSurface: vi.fn().mockImplementation(() => Promise.resolve(snapshot())),
      removeSurface: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockImplementation(() => Promise.resolve(snapshot())),
      onChanged: vi.fn().mockReturnValue(() => {}),
      subscribe: vi.fn().mockReturnValue(() => {}),
      reportExit: vi.fn().mockResolvedValue(undefined),
      acknowledgeEntry: vi.fn().mockResolvedValue(undefined)
    }
  }
})

afterEach(() => {
  act(() => {
    for (const root of roots) {
      root.unmount()
    }
  })
  roots = []
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('PetOverlay identity reporting', () => {
  it('publishes the operator’s pet from the main window, which owns the choice', () => {
    storeState.petId = 'mini-gandalf-the-grey'
    render({})
    expect(setPetId).toHaveBeenCalledWith('mini-gandalf-the-grey')
  })

  it('does NOT publish from a surface whose store has not been hydrated', () => {
    // The regression: without this gate the popout reported 'claudino' and
    // overwrote the real pet for every surface.
    render({ surfaceKind: 'popout-window', reportsPetIdentity: false })
    expect(setPetId).not.toHaveBeenCalled()
  })

  it('publishes once the popout has hydrated the operator’s real pet', () => {
    storeState.petId = 'mini-gandalf-the-grey'
    render({ surfaceKind: 'popout-window', reportsPetIdentity: true })
    expect(setPetId).toHaveBeenCalledWith('mini-gandalf-the-grey')
  })
})
