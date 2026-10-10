import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  getSetupScriptPromptDismissalKey,
  isSetupScriptPromptDismissed
} from '../../lib/setup-script-prompt'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { getRepoHostIdentity } from './repo-host-identity'
import { createTestStore } from './store-test-helpers'
import { makePersistedUI } from './ui-slice-test-harness'

const legacyKey = getSetupScriptPromptDismissalKey('runtime:env-1\0remote-repo')

afterEach(() => {
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCacheForTests()
})

function repo(executionHostId?: Repo['executionHostId']): Repo {
  return {
    id: 'remote-repo',
    path: '/srv/repo',
    displayName: 'Remote',
    badgeColor: '#000',
    addedAt: 1,
    ...(executionHostId ? { executionHostId } : {})
  }
}

function catalog(remoteRepos: Repo[], localRepos: Repo[] = []) {
  clearRuntimeCompatibilityCacheForTests()
  vi.stubGlobal('window', {
    api: {
      repos: { list: async () => localRepos },
      projects: { list: async () => [], listHostSetups: async () => [] },
      runtimeEnvironments: {
        list: async () => [{ id: 'env-1', name: 'Fixture' }],
        call: async (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
            id: args.method,
            ok: true,
            result:
              args.method === 'repo.list' ? { repos: remoteRepos } : { projects: [], setups: [] },
            _meta: { runtimeId: 'runtime-remote' }
          }
      }
    },
    dispatchEvent: vi.fn()
  })
}

function hydrate(entries: string[]) {
  const store = createTestStore()
  store
    .getState()
    .hydratePersistedUI(makePersistedUI({ setupScriptPromptDismissedRepoIds: entries }))
  expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual(entries)
  return store
}

describe('setup prompt dismissal ownership after hydration', () => {
  it('migrates a remembered paired dismissal through the actual complete catalog fetch', async () => {
    const staleKey = getSetupScriptPromptDismissalKey('runtime:missing\0retired-repo')
    const store = hydrate([legacyKey, staleKey])
    catalog([repo()])

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([legacyKey, staleKey])
    await store.getState().fetchReposForAllHosts()

    const fetched = store.getState().repos[0]
    expect(fetched).toBeDefined()
    if (!fetched) {
      throw new Error('Missing fetched repository')
    }
    const identity = getRepoHostIdentity(fetched)
    expect(identity).toBe(JSON.stringify(['runtime:env-1', 'local', 'remote-repo']))
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([
      getSetupScriptPromptDismissalKey(identity)
    ])
    expect(
      isSetupScriptPromptDismissed(identity, store.getState().setupScriptPromptDismissedRepoIds)
    ).toBe(true)
  })

  it.each([false, true])('refuses an ambiguous old paired alias (B first: %s)', async (bFirst) => {
    const store = hydrate([legacyKey])
    const owners = [repo('ssh:private-a'), repo('ssh:private-b')]
    catalog(bFirst ? owners.toReversed() : owners)
    await store.getState().fetchReposForAllHosts()
    expect(store.getState().repos).toHaveLength(2)
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([])
    for (const fetched of store.getState().repos) {
      expect(
        isSetupScriptPromptDismissed(
          getRepoHostIdentity(fetched),
          store.getState().setupScriptPromptDismissedRepoIds
        )
      ).toBe(false)
    }
  })

  it('refuses a legacy raw stamp colliding with the paired publisher alias', async () => {
    const store = hydrate([legacyKey])
    catalog([repo()], [repo('runtime:env-1')])
    await store.getState().fetchReposForAllHosts()
    expect(store.getState().repos).toHaveLength(2)
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([])
  })

  it('retains an exact new owner dismissal without dismissing its same-ID sibling', async () => {
    const exactKey = getSetupScriptPromptDismissalKey(
      JSON.stringify(['runtime:env-1', 'ssh:private-b', 'remote-repo'])
    )
    const store = hydrate([exactKey])
    catalog([repo('ssh:private-a'), repo('ssh:private-b')])
    await store.getState().fetchReposForAllHosts()
    const dismissed = store
      .getState()
      .repos.filter((fetched) =>
        isSetupScriptPromptDismissed(
          getRepoHostIdentity(fetched),
          store.getState().setupScriptPromptDismissedRepoIds
        )
      )
    expect(dismissed.map((fetched) => fetched.authoritativeExecutionHostId)).toEqual([
      'ssh:private-b'
    ])
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([exactKey])
  })

  it('cleans retired remembered entries when the complete catalog is empty', async () => {
    const store = hydrate([legacyKey])
    catalog([])
    await store.getState().fetchReposForAllHosts()
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([])
  })

  it('migrates during hydration when the current owner records are already present', () => {
    const known = {
      ...repo('runtime:env-1'),
      authoritativeExecutionHostId: 'local' as const,
      catalogOwnerHostId: 'runtime:env-1' as const
    }
    const store = createTestStore()
    store.setState({ repos: [known] })
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ setupScriptPromptDismissedRepoIds: [legacyKey] }))
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([
      getSetupScriptPromptDismissalKey(getRepoHostIdentity(known))
    ])
  })
  it('preserves remote repo filters during first-paint local catalog refresh', async () => {
    const store = createTestStore()
    catalog([repo()], [{ ...repo(), id: 'local-repo' }])
    const remoteDismissalKey = getSetupScriptPromptDismissalKey('runtime:env-1\0remote-repo')
    const staleDismissalKey = getSetupScriptPromptDismissalKey('local\0stale-repo')
    store.setState({
      activeRepoId: 'remote-repo',
      filterRepoIds: ['remote-repo', 'stale-repo'],
      setupScriptPromptDismissedRepoIds: [remoteDismissalKey, staleDismissalKey],
      trustedOrcaHooks: {
        'remote-repo': { all: { approvedAt: 1 } },
        'stale-repo': { all: { approvedAt: 2 } }
      }
    })

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })

    expect(store.getState().activeRepoId).toBe('remote-repo')
    expect(store.getState().filterRepoIds).toEqual(['remote-repo', 'stale-repo'])
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([
      remoteDismissalKey,
      staleDismissalKey
    ])
    expect(store.getState().trustedOrcaHooks).toEqual({
      'remote-repo': { all: { approvedAt: 1 } },
      'stale-repo': { all: { approvedAt: 2 } }
    })

    await store.getState().fetchReposForAllHosts()

    expect(store.getState().activeRepoId).toBe('remote-repo')
    expect(store.getState().filterRepoIds).toEqual(['remote-repo'])
    const fetchedRemote = store.getState().repos.find((repo) => repo.id === 'remote-repo')
    if (!fetchedRemote) {
      throw new Error('Missing fetched remote repository')
    }
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([
      getSetupScriptPromptDismissalKey(getRepoHostIdentity(fetchedRemote))
    ])
    expect(store.getState().trustedOrcaHooks).toEqual({
      'remote-repo': { all: { approvedAt: 1 } }
    })
  })
})
