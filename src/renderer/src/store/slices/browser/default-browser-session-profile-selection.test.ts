import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../types'
import {
  createBrowserMockApi,
  createTestStore,
  settingsWithRuntime
} from '../browser-slice-test-harness'
import {
  getDefaultBrowserProfileForHost,
  hydratedDefaultBrowserSessionProfileSelection
} from './browser-host-state'

const mockApi = createBrowserMockApi(vi.fn())

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

const LOCAL_FOCUSED_STATE = {
  browserSessionHostIdOverride: null,
  settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
}

/** Feed the payload that reached the persistence boundary back through hydration. */
function restoredFromLastPersistedPayload(): ReturnType<
  typeof hydratedDefaultBrowserSessionProfileSelection
> {
  const [payload] = mockApi.ui.set.mock.calls.at(-1) ?? []
  return hydratedDefaultBrowserSessionProfileSelection(
    LOCAL_FOCUSED_STATE,
    payload?.defaultBrowserSessionProfileIdByHostId
  )
}

describe('setDefaultBrowserSessionProfileId persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.ui.set.mockResolvedValue(undefined)
  })

  // Why a round trip in one test: the write and the restore are the two halves of
  // the bug (the selection was written nowhere, so nothing could restore it), and
  // asserting them separately lets a renamed persisted key pass both.
  it('writes the selection so hydration restores it, Default included', () => {
    const store = createTestStore()

    store.getState().setDefaultBrowserSessionProfileId('profile-a')

    expect(store.getState().defaultBrowserSessionProfileId).toBe('profile-a')
    expect(restoredFromLastPersistedPayload()).toEqual({
      defaultBrowserSessionProfileId: 'profile-a',
      defaultBrowserSessionProfileIdByHostId: { local: 'profile-a' }
    })

    store.getState().setDefaultBrowserSessionProfileId(null)

    expect(store.getState().defaultBrowserSessionProfileId).toBeNull()
    // An explicit Default persists as null rather than an absent key, so hydration
    // restores Default instead of falling back to it by accident.
    expect(restoredFromLastPersistedPayload()).toEqual({
      defaultBrowserSessionProfileId: null,
      defaultBrowserSessionProfileIdByHostId: { local: null }
    })
  })

  it('keeps every host selection when another host switches profile', () => {
    const store = createTestStore()
    store.getState().setDefaultBrowserSessionProfileId('local-profile')
    store.setState({ browserSessionHostIdOverride: 'runtime:env-1' })

    store.getState().setDefaultBrowserSessionProfileId('runtime-profile')

    expect(store.getState().defaultBrowserSessionProfileIdByHostId).toEqual({
      local: 'local-profile',
      'runtime:env-1': 'runtime-profile'
    })
    expect(restoredFromLastPersistedPayload().defaultBrowserSessionProfileIdByHostId).toEqual({
      local: 'local-profile',
      'runtime:env-1': 'runtime-profile'
    })
  })

  it('does not fail the selection when persisting rejects', () => {
    const store = createTestStore()
    mockApi.ui.set.mockRejectedValue(new Error('disk full'))

    expect(() => store.getState().setDefaultBrowserSessionProfileId('profile-a')).not.toThrow()
    expect(store.getState().defaultBrowserSessionProfileId).toBe('profile-a')
  })
})

describe('deleteBrowserSessionProfile persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.ui.set.mockResolvedValue(undefined)
    mockApi.browser.sessionDeleteProfile.mockResolvedValue(true)
  })

  it('persists the cleared selection when the active profile is deleted', async () => {
    const store = createTestStore()
    store.getState().setDefaultBrowserSessionProfileId('profile-a')
    mockApi.ui.set.mockClear()

    await store.getState().deleteBrowserSessionProfile('profile-a')

    expect(store.getState().defaultBrowserSessionProfileId).toBeNull()
    expect(mockApi.ui.set).toHaveBeenCalledWith({
      defaultBrowserSessionProfileIdByHostId: { local: null }
    })
  })

  // The delete request is awaited, so the selection can change while it is in flight; deciding
  // from the pre-request snapshot would clear the store without persisting the clear.
  it('persists the clear when the profile is selected while the delete is in flight', async () => {
    const store = createTestStore()
    let resolveDelete: (ok: boolean) => void = () => {}
    mockApi.browser.sessionDeleteProfile.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveDelete = resolve
      })
    )

    const deleting = store.getState().deleteBrowserSessionProfile('profile-a')
    store.getState().setDefaultBrowserSessionProfileId('profile-a')
    mockApi.ui.set.mockClear()
    resolveDelete(true)
    await deleting

    expect(store.getState().defaultBrowserSessionProfileId).toBeNull()
    expect(mockApi.ui.set).toHaveBeenCalledWith({
      defaultBrowserSessionProfileIdByHostId: { local: null }
    })
  })

  it('leaves the persisted selection alone when another profile is deleted', async () => {
    const store = createTestStore()
    store.getState().setDefaultBrowserSessionProfileId('profile-a')
    mockApi.ui.set.mockClear()

    await store.getState().deleteBrowserSessionProfile('profile-b')

    expect(store.getState().defaultBrowserSessionProfileId).toBe('profile-a')
    expect(mockApi.ui.set).not.toHaveBeenCalled()
  })
})

// Why this matters after the fix: an explicit Default now persists as null, so a reader
// that treats null as "nothing stored" inherits the *shown* host's profile forever, instead
// of only until the next launch as it did while nothing was persisted at all.
describe('explicit Default on a host', () => {
  it('does not inherit another host profile when reading the selection', () => {
    const store = createTestStore()
    store.setState({
      defaultBrowserSessionProfileIdByHostId: { local: null, 'runtime:env-1': 'profile-b' },
      defaultBrowserSessionProfileId: 'profile-b',
      settings: settingsWithRuntime('env-1')
    })

    expect(getDefaultBrowserProfileForHost(store.getState(), 'local')).toBeNull()
  })

  it('opens a new tab on Default rather than the shown host profile', () => {
    const store = createTestStore()
    store.setState({
      defaultBrowserSessionProfileIdByHostId: { local: null, 'runtime:env-1': 'profile-b' },
      defaultBrowserSessionProfileId: 'profile-b',
      settings: settingsWithRuntime('env-1')
    })

    const tab = store.getState().createBrowserTab('wt-1', 'about:blank', {
      browserRuntimeEnvironmentId: null
    })

    expect(tab.sessionProfileId ?? null).toBeNull()
  })
})

describe('hydratedDefaultBrowserSessionProfileSelection', () => {
  it('restores the selection for the host settings shows', () => {
    expect(
      hydratedDefaultBrowserSessionProfileSelection(LOCAL_FOCUSED_STATE, { local: 'profile-a' })
    ).toEqual({
      defaultBrowserSessionProfileId: 'profile-a',
      defaultBrowserSessionProfileIdByHostId: { local: 'profile-a' }
    })
  })

  it('restores the runtime host selection when settings is focused on that host', () => {
    expect(
      hydratedDefaultBrowserSessionProfileSelection(
        {
          browserSessionHostIdOverride: null,
          settings: settingsWithRuntime('env-1')
        },
        { local: 'profile-a', 'runtime:env-1': 'profile-b' }
      )
    ).toEqual({
      defaultBrowserSessionProfileId: 'profile-b',
      defaultBrowserSessionProfileIdByHostId: {
        local: 'profile-a',
        'runtime:env-1': 'profile-b'
      }
    })
  })

  it('falls back to Default when nothing was persisted', () => {
    expect(hydratedDefaultBrowserSessionProfileSelection(LOCAL_FOCUSED_STATE, undefined)).toEqual({
      defaultBrowserSessionProfileId: null,
      defaultBrowserSessionProfileIdByHostId: {}
    })
  })

  it('falls back to Default when only another host has a persisted selection', () => {
    expect(
      hydratedDefaultBrowserSessionProfileSelection(LOCAL_FOCUSED_STATE, {
        'runtime:env-1': 'profile-b'
      })
    ).toEqual({
      defaultBrowserSessionProfileId: null,
      defaultBrowserSessionProfileIdByHostId: { 'runtime:env-1': 'profile-b' }
    })
  })
})
