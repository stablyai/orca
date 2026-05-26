import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/types'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const secondRepo: Repo = {
  id: 'second-repo',
  path: '/second',
  displayName: 'Second',
  badgeColor: '#111',
  addedAt: 2
}

const reposUpdate = vi.fn()

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  reposUpdate.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: {
        update: reposUpdate
      }
    }
  })
})

describe('repo update serialization', () => {
  it('serializes local repo updates for the same repo before applying state', async () => {
    const firstUpdate = deferred<void>()
    const secondUpdate = deferred<void>()
    const firstHookSettings: NonNullable<Repo['hookSettings']> = {
      mode: 'override',
      setupRunPolicy: 'ask',
      commandSourcePolicy: 'local-only',
      scripts: { setup: 'first setup', archive: '' }
    }
    const secondHookSettings: NonNullable<Repo['hookSettings']> = {
      mode: 'override',
      setupRunPolicy: 'skip-by-default',
      commandSourcePolicy: 'run-both',
      scripts: { setup: 'second setup', archive: 'second archive' }
    }
    reposUpdate.mockImplementationOnce(() => firstUpdate.promise)
    reposUpdate.mockImplementationOnce(() => secondUpdate.promise)
    const store = createTestStore()
    store.setState({ repos: [localRepo] })

    const first = store.getState().updateRepo(localRepo.id, { hookSettings: firstHookSettings })
    const second = store.getState().updateRepo(localRepo.id, { hookSettings: secondHookSettings })

    expect(reposUpdate).toHaveBeenCalledTimes(1)
    expect(store.getState().repos[0]?.hookSettings).toBeUndefined()

    firstUpdate.resolve()
    await first
    await Promise.resolve()

    expect(reposUpdate).toHaveBeenCalledTimes(2)
    expect(store.getState().repos[0]?.hookSettings).toEqual(firstHookSettings)

    secondUpdate.resolve()
    await second

    expect(store.getState().repos[0]?.hookSettings).toEqual(secondHookSettings)
  })

  it('does not serialize updates for different repos', async () => {
    const slowLocalUpdate = deferred<void>()
    reposUpdate.mockImplementationOnce(() => slowLocalUpdate.promise)
    reposUpdate.mockResolvedValueOnce(undefined)
    const store = createTestStore()
    store.setState({ repos: [localRepo, secondRepo] })

    const local = store.getState().updateRepo(localRepo.id, { displayName: 'Local slow' })
    const second = store.getState().updateRepo(secondRepo.id, { displayName: 'Second fast' })

    expect(reposUpdate).toHaveBeenCalledTimes(2)
    await second
    expect(store.getState().repos.find((repo) => repo.id === secondRepo.id)?.displayName).toBe(
      'Second fast'
    )
    expect(store.getState().repos.find((repo) => repo.id === localRepo.id)?.displayName).toBe(
      'Local'
    )

    slowLocalUpdate.resolve()
    await local

    expect(store.getState().repos.find((repo) => repo.id === localRepo.id)?.displayName).toBe(
      'Local slow'
    )
  })

  it('continues a repo update chain after a failed update', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      reposUpdate.mockRejectedValueOnce(new Error('update failed'))
      reposUpdate.mockResolvedValueOnce(undefined)
      const store = createTestStore()
      store.setState({ repos: [localRepo] })

      const failed = store.getState().updateRepo(localRepo.id, { displayName: 'Failed' })
      const recovered = store.getState().updateRepo(localRepo.id, { displayName: 'Recovered' })

      await expect(Promise.all([failed, recovered])).resolves.toEqual([false, true])

      expect(reposUpdate).toHaveBeenCalledTimes(2)
      expect(store.getState().repos[0]?.displayName).toBe('Recovered')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('does not apply repo icons that fail shared sanitization', async () => {
    reposUpdate.mockResolvedValueOnce(undefined)
    const store = createTestStore()
    store.setState({ repos: [localRepo] })

    await store.getState().updateRepo(localRepo.id, {
      repoIcon: {
        type: 'image',
        source: 'upload',
        src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
      } as never
    })

    expect(reposUpdate).toHaveBeenCalledWith({ repoId: localRepo.id, updates: {} })
    expect(store.getState().repos[0]?.repoIcon).toBeUndefined()
  })
})
