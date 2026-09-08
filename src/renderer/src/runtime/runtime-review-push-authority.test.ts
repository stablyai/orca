import { beforeEach, expect, it, vi } from 'vitest'
import { reviewTarget } from '../../../shared/__fixtures__/git-review-target'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'remote', environmentId: 'env' }),
  callRuntimeRpc: rpc
}))
import { pushRuntimeGit } from './runtime-git-sync-client'
const context = {
  settings: { activeRuntimeEnvironmentId: 'env' },
  worktreeId: 'wt',
  worktreePath: '/repo'
}
const target = reviewTarget('origin', 'feature')
beforeEach(() => rpc.mockReset())
it.each([
  undefined,
  { kind: 'mismatch', reviewHead: target.reviewHead },
  { kind: 'ambiguous', reviewHead: target.reviewHead }
])('rejects old or unverified host evidence %j before push', async (authority) => {
  rpc.mockResolvedValue({ hasUpstream: true, ahead: 1, behind: 0, reviewPushAuthority: authority })
  await expect(pushRuntimeGit(context, { pushTarget: target })).rejects.toThrow('not verified')
  expect(rpc).toHaveBeenCalledOnce()
  expect(rpc.mock.calls[0]?.[1]).toBe('git.upstreamStatus')
})
it('dispatches only after host status corroborates the same target identity', async () => {
  rpc
    .mockResolvedValueOnce({
      hasUpstream: true,
      ahead: 1,
      behind: 0,
      upstreamIdentity: {
        selector: { kind: 'named-remote', value: 'origin' },
        mergeRef: 'refs/heads/feature',
        trackingRef: null
      },
      reviewPushAuthority: { kind: 'verified', reviewHead: target.reviewHead }
    })
    .mockResolvedValueOnce({ ok: true })
  await pushRuntimeGit(context, { pushTarget: target })
  expect(rpc.mock.calls[1]?.[1]).toBe('git.push')
  expect(rpc.mock.calls[1]?.[2]).toMatchObject({ pushTarget: target })
})
