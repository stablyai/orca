import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncognitoLockState } from '../../../../shared/incognito-projects'
import type { Repo } from '../../../../shared/repo-types'
import { createTestStore, TEST_REPO } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubIncognitoApi(state: Partial<IncognitoLockState>) {
  const api = {
    getState: vi.fn(async () => ({
      unlocked: false,
      touchIdAvailable: false,
      passcodeSet: false,
      ...state
    })),
    unlockWithTouchId: vi.fn(async () => ({ ok: false, reason: 'cancelled' })),
    lock: vi.fn(async () => {})
  }
  vi.stubGlobal('window', { api: { incognitoProjects: api } })
  return api
}

function storeWithRepo(repo: Repo) {
  const store = createTestStore()
  const updateRepo = vi.fn(async () => true)
  store.setState({ repos: [repo], updateRepo })
  return { store, updateRepo }
}

describe('incognito projects slice', () => {
  it('asks for a passcode before hiding the first project when no unlock method exists', async () => {
    const api = stubIncognitoApi({ passcodeSet: false })
    const { store, updateRepo } = storeWithRepo(TEST_REPO)

    await store.getState().setProjectIncognito(TEST_REPO, true)

    expect(updateRepo).not.toHaveBeenCalled()
    expect(store.getState().incognitoProjectsDialog).toEqual({
      kind: 'setup',
      pendingRepo: { id: TEST_REPO.id, hostId: 'local' }
    })

    store.getState().setIncognitoProjectsUnlocked(true)
    await store.getState().completeIncognitoProjectsSetup()
    expect(updateRepo).toHaveBeenCalledWith(TEST_REPO.id, { incognito: true }, { hostId: 'local' })
    expect(api.lock).toHaveBeenCalledTimes(1)
    expect(store.getState().incognitoProjectsUnlocked).toBe(false)
    expect(store.getState().incognitoProjectsDialog).toBeNull()
  })

  it('hides a project straight away once a passcode exists', async () => {
    stubIncognitoApi({ passcodeSet: true })
    const { store, updateRepo } = storeWithRepo(TEST_REPO)

    await store.getState().setProjectIncognito(TEST_REPO, true)

    expect(updateRepo).toHaveBeenCalledWith(TEST_REPO.id, { incognito: true }, { hostId: 'local' })
    expect(store.getState().incognitoProjectsDialog).toBeNull()
  })

  it('falls back to the passcode dialog when Touch ID is cancelled', async () => {
    const api = stubIncognitoApi({ touchIdAvailable: true, passcodeSet: true })
    const { store } = storeWithRepo(TEST_REPO)

    await store.getState().requestIncognitoProjectsUnlock()

    expect(api.unlockWithTouchId).toHaveBeenCalledTimes(1)
    expect(store.getState().incognitoProjectsDialog).toEqual({ kind: 'unlock' })
  })

  it('does nothing when already unlocked', async () => {
    const api = stubIncognitoApi({ unlocked: true, passcodeSet: true })
    const { store } = storeWithRepo(TEST_REPO)

    await store.getState().requestIncognitoProjectsUnlock()

    expect(api.unlockWithTouchId).not.toHaveBeenCalled()
    expect(store.getState().incognitoProjectsDialog).toBeNull()
  })
})
