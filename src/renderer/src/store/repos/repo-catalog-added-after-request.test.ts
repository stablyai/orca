// A catalog answer that left before an add must not drop the project that add just made.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getEmptyProjectPlaceholderRepoIds } from '../../../../shared/sidebar-list/empty-project-placeholder-repos'
import { mergeFetchedRepoCatalog, type FetchedRepoCatalog } from './repo-catalog-merge'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

function repo(id: string, overrides: Partial<Repo>): Repo {
  return {
    id,
    path: `/home/me/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

function staleAnswer(
  hostId: FetchedRepoCatalog['hostId'],
  listed: readonly Repo[],
  reposAtRequest: readonly Repo[]
): FetchedRepoCatalog {
  return {
    repos: listed,
    projectHostSetupCompatibility: { projects: [], setups: [] },
    hostId,
    reposAtRequest
  }
}

const hosts: [string, FetchedRepoCatalog['hostId'], Partial<Repo>][] = [
  ['a WSL host', 'runtime:wsl-ubuntu', { executionHostId: 'runtime:wsl-ubuntu' }],
  [
    'an SSH target on a paired server',
    'runtime:server-1',
    { executionHostId: 'runtime:server-1', connectionId: 'ssh-box' }
  ],
  ['this computer', 'local', {}]
]

describe('a catalog answer that predates an add', () => {
  afterEach(() => callRuntimeRpc.mockReset())

  it.each(hosts)('keeps the project just added on %s', (_label, hostId, owner) => {
    const old = repo('old', owner)
    const added = repo('added', owner)
    const merged = mergeFetchedRepoCatalog(staleAnswer(hostId, [old], [old]), [old, added]).repos
    expect(merged.map((entry) => entry.id)).toEqual(['old', 'added'])
  })

  it.each(hosts)('still drops a project %s stopped listing', (_label, hostId, owner) => {
    const old = repo('old', owner)
    const gone = repo('gone', owner)
    const merged = mergeFetchedRepoCatalog(staleAnswer(hostId, [old], [old, gone]), [
      old,
      gone
    ]).repos
    expect(merged.map((entry) => entry.id)).toEqual(['old'])
  })

  it('a stopped WSL host still shows the added project, from store data alone', () => {
    const owner: Partial<Repo> = { executionHostId: 'runtime:wsl-ubuntu' }
    const old = repo('old', owner)
    const added = repo('added', owner)
    const connect = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { connect, call: vi.fn() } } })
    try {
      const repos = mergeFetchedRepoCatalog(staleAnswer('runtime:wsl-ubuntu', [old], [old]), [
        old,
        added
      ]).repos
      // Its worktrees never loaded: the host stopped before they could be read.
      const placeholders = getEmptyProjectPlaceholderRepoIds({
        groupBy: 'repo',
        repos,
        worktreesByRepo: {},
        visibleWorktrees: [],
        filterRepoIds: []
      })
      expect(placeholders.has('added')).toBe(true)
      // Showing the row reaches no host, so it cannot start the distro.
      expect(callRuntimeRpc).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
