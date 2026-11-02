import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  issueCacheKey,
  prCacheKey,
  sourceScopedRepoCacheKey,
  workItemsCacheKey
} from '../github/cache-identity'
import {
  createTestStore,
  githubSourceContext,
  makePR,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import type { Repo } from '../../../../shared/repo-types'

const SSH_HOST = toSshExecutionHostId('builder')
const RUNTIME_HOST = 'runtime:paired'

const localRow: Repo = {
  id: 'twin',
  path: '/laptop/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1
}
// Why no executionHostId: older SSH rows carry only connectionId.
const sshRow: Repo = { ...localRow, path: '/remote/twin', addedAt: 2, connectionId: 'builder' }

function sshSourceScopes(repoId: string): string[] {
  const full = githubSourceContext(SSH_HOST, repoId)
  // Why: empty parts put `::` inside the scope, which a first-`::` split misreads.
  const sparse = { ...full, projectHostSetupId: null, providerIdentity: null }
  return [getTaskSourceCacheScope(full), getTaskSourceCacheScope(sparse)]
}

/** Every repo-owned cache seeded with one entry per host scope, keyed by the real builders. */
function seedEveryHostScope(repoId: string, repoPath: string) {
  const entry = { data: [], fetchedAt: 1 }
  const hosts = { local: null, ssh: SSH_HOST, runtime: RUNTIME_HOST } as const
  const keys = Object.fromEntries(
    Object.entries(hosts).map(([name, hostId]) => [
      name,
      {
        workItems: workItemsCacheKey(repoId, 20, '', hostId),
        pr: prCacheKey(repoPath, repoId, 'main', null, null, hostId, true),
        issue: issueCacheKey(repoPath, repoId, 7, null, null, hostId, true),
        checks: sourceScopedRepoCacheKey(repoPath, repoId, 'pr-checks::7', null, null, hostId)
      }
    ])
  )
  const sourceKeys = sshSourceScopes(repoId).map((scope) =>
    workItemsCacheKey(repoId, 20, '', scope)
  )
  const all = Object.values(keys)
  return {
    keys,
    sourceKeys,
    state: {
      workItemsCache: Object.fromEntries(
        [...all.map((k) => k.workItems), ...sourceKeys].map((key) => [key, entry])
      ),
      prCache: Object.fromEntries(all.map((k) => [k.pr, { data: makePR(), fetchedAt: 1 }])),
      issueCache: Object.fromEntries(all.map((k) => [k.issue, { data: null, fetchedAt: 1 }])),
      checksCache: Object.fromEntries(all.map((k) => [k.checks, entry]))
    }
  }
}

function cachedKeys(store: ReturnType<typeof createTestStore>): string[] {
  const s = store.getState()
  return [s.workItemsCache, s.prCache, s.issueCache, s.checksCache].flatMap((cache) =>
    Object.keys(cache)
  )
}

describe('repo cache eviction across host scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('evicting a repo clears its local, SSH-scoped and runtime-scoped entries, and no other repo’s', () => {
    const store = createTestStore()
    const removed = seedEveryHostScope('repo-1', '/repo/one')
    const other = seedEveryHostScope('repo-2', '/repo/two')
    store.setState({
      repos: [{ ...localRow, id: 'repo-1', path: '/repo/one' }],
      workItemsCache: { ...removed.state.workItemsCache, ...other.state.workItemsCache },
      prCache: { ...removed.state.prCache, ...other.state.prCache },
      issueCache: { ...removed.state.issueCache, ...other.state.issueCache },
      checksCache: { ...removed.state.checksCache, ...other.state.checksCache }
    })

    store.getState().evictGitHubRepoCaches('repo-1', '/repo/one', 'local')

    expect(cachedKeys(store).sort()).toEqual(
      [
        ...Object.keys(other.state.workItemsCache),
        ...Object.keys(other.state.prCache),
        ...Object.keys(other.state.issueCache),
        ...Object.keys(other.state.checksCache)
      ].sort()
    )
  })

  it('keeps another repo’s entry under a source scope that names this repo', () => {
    const store = createTestStore()
    const [, sparseScope] = sshSourceScopes('repo-1')
    const otherKey = workItemsCacheKey('repo-2', 20, '', sparseScope)
    store.setState({ workItemsCache: { [otherKey]: { data: [], fetchedAt: 1 } } })

    store.getState().evictGitHubRepoCaches('repo-1', '/repo/one')

    expect(Object.keys(store.getState().workItemsCache)).toEqual([otherKey])
  })

  it('removing the SSH twin keeps the local twin’s entries, and the reverse', () => {
    const seeded = seedEveryHostScope('twin', localRow.path)
    const local = Object.values(seeded.keys.local)
    const ssh = [...Object.values(seeded.keys.ssh), ...seeded.sourceKeys]

    const store = createTestStore()
    store.setState({ repos: [localRow, sshRow], ...seeded.state })
    store.getState().evictGitHubRepoCaches('twin', sshRow.path, SSH_HOST)
    expect(cachedKeys(store)).toEqual(expect.arrayContaining(local))
    expect(cachedKeys(store).filter((key) => ssh.includes(key))).toEqual([])

    const reverse = createTestStore()
    reverse.setState({ repos: [localRow, sshRow], ...seeded.state })
    reverse.getState().evictGitHubRepoCaches('twin', localRow.path, 'local')
    expect(cachedKeys(reverse)).toEqual(expect.arrayContaining(ssh))
    expect(cachedKeys(reverse).filter((key) => local.includes(key))).toEqual([])
  })
})
