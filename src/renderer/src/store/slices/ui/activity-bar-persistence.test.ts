import { expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'
import { persistedUIWriteFieldsToWireUpdate } from './persisted-ui-write-baseline'

it('restores the saved activity order and hidden panels from the write payload', () => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
  try {
    const payload = persistedUIWriteFieldsToWireUpdate({
      activityBarOrder: ['explorer', 'plugin:test:panel'],
      activityBarHidden: ['plugin:test:panel']
    })
    const store = createUIStore()
    store.getState().hydratePersistedUI(makePersistedUI(payload))
    expect(store.getState().activityBarOrder).toEqual(['explorer', 'plugin:test:panel'])
    expect(store.getState().activityBarHidden).toEqual(['plugin:test:panel'])
  } finally {
    vi.unstubAllGlobals()
  }
})

it('does not treat equal hydrated arrangements as local edits or overwrite a newer window', () => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
  try {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ activityBarOrder: ['explorer'], activityBarHidden: ['plugin:a'] })
      )
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ activityBarOrder: ['checks', 'explorer'], activityBarHidden: [] }),
        'sync'
      )
    expect(store.getState().activityBarOrder).toEqual(['checks', 'explorer'])
    expect(store.getState().activityBarHidden).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
})

it('keeps newer local changes when an in-flight write is acknowledged', () => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
  try {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ activityBarOrder: ['explorer'], activityBarHidden: [] })
      )
    store.setState({ activityBarOrder: ['checks', 'explorer'], activityBarHidden: ['plugin:a'] })
    store.getState().notePersistedUIWriteStarted(['activityBarOrder', 'activityBarHidden'])
    store.setState({ activityBarOrder: ['explorer', 'checks'], activityBarHidden: [] })
    store.getState().hydratePersistedUI(
      makePersistedUI({
        activityBarOrder: ['checks', 'explorer'],
        activityBarHidden: ['plugin:a']
      }),
      'sync'
    )
    expect(store.getState().activityBarOrder).toEqual(['explorer', 'checks'])
    expect(store.getState().activityBarHidden).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
})
