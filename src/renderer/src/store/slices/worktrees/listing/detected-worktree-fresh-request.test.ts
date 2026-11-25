import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetectedWorktreesArgs } from '../../../../../../shared/worktree/catalog/detected-worktree-provider-contract'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../../../runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc }))

import { createDetectedWorktreeRefreshLeaseRegistry } from './detected-worktree-refresh-leases'
import { listDetectedWorktreesForRepo } from './detected-worktree-provider-request'

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ repoId: 'repo', authoritative: true, source: 'git', worktrees: [] })
})

// A settled host scan or cached failure can predate the caller's write or Git's recovery.
describe('a fresh detected-worktree read asks its host for a new Git observation', () => {
  it('on this machine, through the provider request', () => {
    const requests: ListDetectedWorktreesArgs[] = []
    const registry = createDetectedWorktreeRefreshLeaseRegistry({
      startProviderRequest: (request) => {
        requests.push(request)
        return new Promise(() => undefined)
      },
      cancelProviderRequest: () => undefined
    })
    const input = { repoId: 'repo', executionHostId: 'local' as const }
    registry.acquire('key', input)
    registry.acquire('key', input, true)
    expect(requests.map((request) => 'fresh' in request && request.fresh)).toEqual([false, true])
  })

  it('on a paired runtime, through its RPC', async () => {
    const target = { kind: 'environment' as const, environmentId: 'env' }
    await listDetectedWorktreesForRepo(target, 'repo')
    await listDetectedWorktreesForRepo(target, 'repo', { fresh: true })
    expect(rpc.mock.calls.map((call) => call[2])).toEqual([
      { repo: 'repo' },
      { repo: 'repo', fresh: true }
    ])
  })
})
