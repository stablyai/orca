import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { createTestStore } from '../store/slices/store-test-helpers'
import { createDirectSshHostHydration } from './direct-ssh-host-hydration'

const authority: DirectSshAuthority = {
  targetId: 'target-a',
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture uses one opaque epoch identity throughout.
  providerEpoch: 'catalog-epoch' as SshProviderEpoch,
  connectionGeneration: 1
}

const remoteRepo: Repo = {
  id: 'shared',
  path: '/srv/repo',
  displayName: 'Remote repo',
  badgeColor: '',
  addedAt: 1,
  connectionId: authority.targetId,
  executionHostId: 'ssh:target-a',
  hookSettings: { mode: 'auto', scripts: { setup: 'echo ready', archive: '' } },
  symlinkPaths: ['.env'],
  repoIcon: { type: 'lucide', name: 'Box' }
}

function fixture() {
  const localRepo: Repo = {
    ...remoteRepo,
    path: '/local/repo',
    connectionId: null,
    executionHostId: 'local'
  }
  const folderRepo: Repo = { ...remoteRepo, id: 'folder', kind: 'folder', path: '/srv/folder' }
  const initialRepos = [remoteRepo, localRepo, folderRepo]
  const store = createTestStore()
  store.setState({
    repos: initialRepos,
    manualRepoOrder: [
      { hostId: 'ssh:target-a', repoId: 'shared' },
      { hostId: 'local', repoId: 'shared' },
      { hostId: 'ssh:target-a', repoId: 'folder' }
    ]
  })
  let fetched: readonly Repo[] = [remoteRepo, folderRepo]
  const hydration = createDirectSshHostHydration({
    store,
    listRepos: async () => ({
      authoritative: true,
      authority: { kind: 'direct-ssh', executionHostId: 'ssh:target-a', ...authority },
      repos: structuredClone(fetched)
    }),
    listLineage: vi.fn(),
    isCurrentAuthority: () => true
  })
  const listener = vi.fn()
  store.subscribe(listener)
  return {
    store,
    hydration,
    listener,
    initialRepos,
    localRepo,
    folderRepo,
    setFetched: (repos: readonly Repo[]) => {
      fetched = repos
    }
  }
}

describe('direct SSH host catalog publication', () => {
  it('does not publish cloned equal repos across twenty refreshes', async () => {
    const { store, hydration, listener, initialRepos } = fixture()
    const initialState = store.getState()
    for (let index = 0; index < 20; index++) {
      await hydration.capturePreparationInput(authority, 'wake-refresh')
    }
    expect(store.getState().repos).toBe(initialRepos)
    expect(store.getState()).toBe(initialState)
    expect(listener).not.toHaveBeenCalled()
    hydration.stop()
  })

  it('publishes a nested change once and retains equal sibling identities', async () => {
    const { store, hydration, listener, localRepo, folderRepo, setFetched } = fixture()
    const changed = { ...remoteRepo, symlinkPaths: ['.env', '.env.local'] }
    setFetched([changed, folderRepo])
    await hydration.capturePreparationInput(authority, 'wake-refresh')
    expect(store.getState().repos).toEqual([changed, localRepo, folderRepo])
    expect(store.getState().repos[0]).not.toBe(remoteRepo)
    expect(store.getState().repos[1]).toBe(localRepo)
    expect(store.getState().repos[2]).toBe(folderRepo)
    expect(listener).toHaveBeenCalledOnce()
    await hydration.capturePreparationInput(authority, 'wake-refresh')
    expect(listener).toHaveBeenCalledOnce()
    hydration.stop()
  })

  it('removes only target rows and retains manual order when adding a repo', async () => {
    const { store, hydration, listener, localRepo, folderRepo, setFetched } = fixture()
    const added = { ...remoteRepo, id: 'added', path: '/srv/added' }
    setFetched([added, folderRepo])
    await hydration.capturePreparationInput(authority, 'wake-refresh')
    expect(store.getState().repos).toEqual([localRepo, folderRepo, added])
    expect(store.getState().repos[0]).toBe(localRepo)
    expect(store.getState().repos[1]).toBe(folderRepo)
    expect(listener).toHaveBeenCalledOnce()
    hydration.stop()
  })

  it('still advances catalog observation revisions when rows stay equal', async () => {
    const { hydration, listener } = fixture()
    const first = await hydration.capturePreparationInput(authority, 'reconnect')
    const second = await hydration.capturePreparationInput(authority, 'wake-refresh')
    expect(first).not.toBeNull()
    expect(second?.catalogRevision).toBe(first!.catalogRevision + 1)
    const repoFingerprint = JSON.stringify([
      ['ssh:target-a', 'folder'],
      ['ssh:target-a', 'shared']
    ])
    expect(
      hydration.isPreparationTokenCurrent({
        authority,
        catalogRevision: first!.catalogRevision,
        repoFingerprint
      })
    ).toBe(false)
    expect(
      hydration.isPreparationTokenCurrent({
        authority,
        catalogRevision: second!.catalogRevision,
        repoFingerprint
      })
    ).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    hydration.stop()
  })
})
