import { expect, it, vi } from 'vitest'
import type { RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import {
  branchSwitchExistingBranch,
  searchRuntimeRemoteBranches,
  switchRuntimeGitBranch
} from './runtime-git-branch-client'
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
const context: RuntimeGitContext = {
  target: { kind: 'environment', environmentId: 'owner' },
  worktreeId: 'repo::/repo',
  worktreePath: '/repo'
}
it('keeps creation available on old hosts and explains the missing operation', async () => {
  vi.mocked(callRuntimeRpc).mockRejectedValueOnce(
    new RuntimeRpcCallError({
      id: 'old',
      ok: false,
      error: { code: 'method_not_found', message: 'missing' }
    })
  )
  await expect(
    switchRuntimeGitBranch(context, { kind: 'new', name: 'feature' }, 'Build Mac')
  ).rejects.toThrow('Update Orca on Build Mac to switch branches from here.')
  expect(callRuntimeRpc).toHaveBeenLastCalledWith(context.target, 'git.switchBranch', {
    worktree: 'id:repo::/repo',
    target: { kind: 'new', name: 'feature' }
  })
})
it('preserves landed warnings and direct collision recovery data', async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValueOnce({
    ok: true,
    branch: 'feature',
    warning: 'Switched to feature, but a hook failed.'
  })
  expect(
    await switchRuntimeGitBranch(context, { kind: 'local', name: 'feature' }, 'Build Mac')
  ).toEqual({ ok: true, branch: 'feature', warning: 'Switched to feature, but a hook failed.' })
  const failure = new RuntimeRpcCallError({
    id: 'collision',
    ok: false,
    error: {
      code: 'runtime_error',
      message: 'Switch to the existing branch.',
      data: { existingBranch: 'feature' }
    }
  })
  expect(branchSwitchExistingBranch(failure)).toBe('feature')
})
it('propagates remote discovery failure instead of a false empty page', async () => {
  const failure = new Error('read failed')
  vi.mocked(callRuntimeRpc).mockRejectedValueOnce(failure)
  await expect(searchRuntimeRemoteBranches(context, 'repo', 'topic')).rejects.toBe(failure)
  expect(callRuntimeRpc).toHaveBeenLastCalledWith(context.target, 'repo.searchRefs', {
    repo: 'repo',
    query: 'topic',
    limit: 50,
    namespace: 'remote'
  })
})
