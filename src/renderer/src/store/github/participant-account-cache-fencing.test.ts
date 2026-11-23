import { createTestStore } from '../testing/app-store-test-fixture'
import type { Repo } from '../../../../shared/repository/repo-types'
import { invalidateGitHubParticipantReads } from '../../runtime/github-participant-read-fencing'
import { expect, it } from 'vitest'
import { repoCacheEviction, sourceScopedRepoCacheKey } from './cache/cache-identity'
import {
  clearInflightGitHubRequestsForRepo,
  trackGitHubMutationCacheWrite,
  runWithGitHubMutationCacheWrite
} from './requests/request-coordination'

it('retires only the changed account scope and keeps a successor fenced after the old mutation settles', () => {
  const repos: Pick<Repo, 'id' | 'executionHostId'>[] = [
    { id: 'repo', executionHostId: 'local' },
    { id: 'repo', executionHostId: 'runtime:server' }
  ]
  const localKey = sourceScopedRepoCacheKey('/repo', 'repo', 'comments', undefined, null, 'local')
  const remoteKey = sourceScopedRepoCacheKey(
    '/repo',
    'repo',
    'comments',
    undefined,
    null,
    'runtime:server'
  )
  const eviction = repoCacheEviction(repos, 'repo', '/repo', 'local')
  const old = trackGitHubMutationCacheWrite(localKey)
  const remote = trackGitHubMutationCacheWrite(remoteKey)
  clearInflightGitHubRequestsForRepo(eviction)
  const successor = trackGitHubMutationCacheWrite(localKey)
  old.dispose()
  expect(old.isCurrent()).toBe(false)
  expect(remote.isCurrent()).toBe(true)
  expect(successor.isCurrent()).toBe(true)
  clearInflightGitHubRequestsForRepo(eviction)
  expect(successor.isCurrent()).toBe(false)
  remote.dispose()
  successor.dispose()
})

it('retires Tasks records and source collection deliveries after a participant switch with the same shared binding', () => {
  const repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '',
    addedAt: 0,
    ghAccount: { host: 'github.com', user: 'shared' }
  }
  const store = createTestStore()
  store.setState({ repos: [repo] })
  const records = store.getState().githubTaskCache
  const collections = store.getState().githubSourceCollections
  records.syncBindings([repo])
  collections.sync([repo])
  const accepted = records.capture(repo)
  if (!accepted) {
    throw new Error('Expected the registered local repository to have a task binding.')
  }
  const attempt = collections.capture(repo)
  expect(records.current(accepted)).toBe(true)
  expect(collections.current(attempt)).toBe(true)
  invalidateGitHubParticipantReads({ kind: 'local' }, repo.id)
  records.syncBindings([repo])
  collections.sync([repo])
  expect(records.current(accepted)).toBe(false)
  expect(collections.current(attempt)).toBe(false)
  expect(collections.current(collections.capture(repo))).toBe(true)
  expect(repo.ghAccount).toEqual({ host: 'github.com', user: 'shared' })
})

it('holds the mutation fence through the response continuation before committing private data', async () => {
  const response = Promise.withResolvers<string>()
  const key = sourceScopedRepoCacheKey('/repo', 'repo', 'comments', undefined, null, 'local')
  const result = runWithGitHubMutationCacheWrite(key, async (write) => {
    const data = await response.promise
    queueMicrotask(() =>
      clearInflightGitHubRequestsForRepo(repoCacheEviction([], 'repo', '/repo', 'local'))
    )
    await Promise.resolve()
    return write.isCurrent() ? data : null
  })
  response.resolve('Alice private data')
  await expect(result).resolves.toBeNull()
})
