import { afterEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from './runtime-rpc-client'
import { invalidateGitHubParticipantReads } from './github-participant-read-fencing'
const target = { kind: 'environment', environmentId: 'shared-server' } as const
const options = { skipCompatibilityCheck: true }
afterEach(() => vi.unstubAllGlobals())
it('rejects late Alice read results after Bob is selected, while preserving mutation receipts', async () => {
  const alice = Promise.withResolvers<unknown>()
  const mutation = Promise.withResolvers<unknown>()
  const call = vi
    .fn()
    .mockReturnValueOnce(alice.promise)
    .mockReturnValueOnce(mutation.promise)
    .mockResolvedValueOnce({ ok: true, result: { title: 'Bob result' } })
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
  const oldRead = callRuntimeRpc(target, 'github.issue', { repo: 'repo-1', number: 1 }, options)
  const receipt = callRuntimeRpc(
    target,
    'github.addIssueComment',
    { repo: 'repo-1', number: 1, body: 'Hello' },
    options
  )
  invalidateGitHubParticipantReads(target, 'repo-1')
  await expect(
    callRuntimeRpc(target, 'github.issue', { repo: 'repo-1', number: 1 }, options)
  ).resolves.toEqual({ title: 'Bob result' })
  const oldResult = expect(oldRead).rejects.toMatchObject({ name: 'AbortError' })
  alice.resolve({ ok: true, result: { title: 'Alice private result' } })
  await oldResult
  mutation.resolve({ ok: true, result: { commentId: 'created' } })
  await expect(receipt).resolves.toEqual({ commentId: 'created' })
})
it('does not cancel reads for another host or project', async () => {
  const pending = Promise.withResolvers<unknown>()
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { call: vi.fn().mockReturnValue(pending.promise) } }
  })
  const read = callRuntimeRpc(target, 'github.prFileContents', { repo: 'repo-1' }, options)
  invalidateGitHubParticipantReads(target, 'repo-2')
  invalidateGitHubParticipantReads({ kind: 'environment', environmentId: 'other-server' }, 'repo-1')
  pending.resolve({ ok: true, result: 'contents' })
  await expect(read).resolves.toBe('contents')
})
