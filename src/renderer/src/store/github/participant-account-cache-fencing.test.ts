import { createStore } from 'zustand/vanilla'
import type { AppState } from '../types'
import { GitHubTaskRecordCache } from './task-records/task-record-cache'
import { GitHubSourceCollections } from './sources/source-collections'
import { invalidateGitHubParticipantReads } from '../../runtime/github-participant-read-fencing'
import { expect, it } from 'vitest'
import { repoCacheEviction, sourceScopedRepoCacheKey } from './cache/cache-identity'
import {
  clearInflightGitHubRequestsForRepo,
  trackGitHubMutationCacheWrite
} from './requests/request-coordination'

it('retires only the changed account scope and keeps a successor fenced after the old mutation settles', () => {
  const repos = [
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These real cache owners read only the supplied repository/cache state and their installed owners.
  const store = createStore<AppState>(
    () => ({ repos: [repo], workItemsCache: {}, workItemsInvalidationNonce: 0 }) as AppState
  )
  const records = new GitHubTaskRecordCache(store)
  const collections = new GitHubSourceCollections(store)
  store.setState({ githubTaskCache: records, githubSourceCollections: collections })
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
