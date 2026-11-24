import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

const BOARD_USED = { 'workspace-board': { firstInteractedAt: 1, interactionCount: 1 } }

beforeEach(() => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('is unknown until persisted UI loads', () => {
  expect(createUIStore().getState().workspaceBoardUsedBeforeLaunch).toBeNull()
})

it('records board use from the first loaded profile', () => {
  const store = createUIStore()
  store
    .getState()
    .hydratePersistedUI(makePersistedUI({ featureInteractions: BOARD_USED }), 'startup')
  expect(store.getState().workspaceBoardUsedBeforeLaunch).toBe(true)
})

it('keeps the launch answer when later syncs carry board use from this launch', () => {
  const store = createUIStore()
  store.getState().hydratePersistedUI(makePersistedUI({ featureInteractions: {} }), 'startup')
  expect(store.getState().workspaceBoardUsedBeforeLaunch).toBe(false)

  store.getState().hydratePersistedUI(makePersistedUI({ featureInteractions: BOARD_USED }), 'sync')
  expect(store.getState().featureInteractions['workspace-board']).toBeTruthy()
  expect(store.getState().workspaceBoardUsedBeforeLaunch).toBe(false)
})
