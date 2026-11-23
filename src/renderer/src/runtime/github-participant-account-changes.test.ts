import type { Repo } from '../../../shared/repository/repo-types'
import { githubTaskBinding } from '@/lib/work-items/github/github-task-observation'
import { invalidateGitHubParticipantReads } from './github-participant-read-fencing'
import { afterEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from './rpc/calls/runtime-rpc-call'
import {
  applyGitHubParticipantAccountsChanged,
  subscribeGitHubParticipantAccountsChanged
} from './github-participant-account-changes'
const { evict, state } = vi.hoisted(() => {
  const evict = vi.fn()
  return {
    evict,
    state: {
      evictGitHubRepoCaches: evict,
      repos: [
        { id: 'one', path: '/one', executionHostId: 'runtime:server' },
        { id: 'two', path: '/two', executionHostId: 'runtime:server' },
        { id: 'one', path: '/local', executionHostId: 'local' }
      ]
    }
  }
})
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => state } }))
afterEach(() => {
  vi.unstubAllGlobals()
  evict.mockReset()
})
it('handles another device changing the shared member while Settings is closed', async () => {
  const old = Promise.withResolvers<unknown>()
  const target = { kind: 'environment', environmentId: 'server' } as const
  const read = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ ok: true, result: 'Bob' })
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: read } } })
  const oldRead = callRuntimeRpc(
    target,
    'github.issue',
    { repo: '/alias/one' },
    { skipCompatibilityCheck: true }
  )
  const notify = vi.fn()
  const stop = subscribeGitHubParticipantAccountsChanged(target, notify)
  applyGitHubParticipantAccountsChanged(target)
  expect(evict.mock.calls).toEqual([
    ['one', '/one', 'runtime:server'],
    ['two', '/two', 'runtime:server']
  ])
  expect(notify).toHaveBeenCalledTimes(1)
  await expect(
    callRuntimeRpc(target, 'github.issue', { repo: 'one' }, { skipCompatibilityCheck: true })
  ).resolves.toBe('Bob')
  const rejected = expect(oldRead).rejects.toMatchObject({ name: 'AbortError' })
  old.resolve({ ok: true, result: 'Alice' })
  await rejected
  stop()
})

it('changes Tasks owner bindings when a participant account changes without editing the shared repo binding', () => {
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '',
    addedAt: 0,
    executionHostId: 'runtime:account-owner',
    ghAccount: { host: 'github.com', user: 'shared' }
  }
  const unrelated: Repo = { ...repo, executionHostId: 'runtime:other-owner' }
  const before = githubTaskBinding(repo)
  const otherBefore = githubTaskBinding(unrelated)
  invalidateGitHubParticipantReads({ kind: 'environment', environmentId: 'account-owner' })
  expect(githubTaskBinding(repo)).not.toBe(before)
  expect(githubTaskBinding(unrelated)).toBe(otherBefore)
  expect(repo.ghAccount).toEqual({ host: 'github.com', user: 'shared' })
})
