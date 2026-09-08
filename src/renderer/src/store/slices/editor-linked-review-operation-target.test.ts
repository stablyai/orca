import { reviewTarget } from '../../../../shared/__fixtures__/git-review-target'
import { beforeEach, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import { hasUsableHostedReviewPushTarget } from '../../../../shared/hosted-review-push-target-admission'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({ notifyHostOfMirroredEditorClose: vi.fn() }))
const push = vi.fn()
const fetch = vi.fn()
beforeEach(() => {
  push.mockReset()
  fetch.mockReset()
  Object.assign(globalThis, {
    window: {
      api: {
        git: {
          push,
          fetch,
          upstreamStatus: vi.fn().mockResolvedValue({ hasUpstream: false, ahead: 0, behind: 0 })
        }
      }
    }
  })
})

it.each(['linkedPR', 'linkedGitLabMR'] as const)(
  'keeps %s unresolved through the shipping push and sync dispatcher until target hydration',
  async (link) => {
    const store = createEditorStore()
    const worktree = makeWorktree({ id: 'wt', repoId: 'repo', [link]: 42 })
    store.setState({ getKnownWorktreeById: () => worktree })
    const upstreamStatus = {
      hasUpstream: true,
      ahead: 1,
      behind: 0,
      upstreamIdentity: {
        selector: { kind: 'named-remote' as const, value: 'origin' },
        mergeRef: 'refs/heads/feature',
        trackingRef: 'refs/remotes/origin/feature'
      }
    }
    expect(
      hasUsableHostedReviewPushTarget({
        branchName: 'feature',
        upstreamStatus,
        hasResolvableHostedReviewPushTargetLink: true
      })
    ).toBe(false)
    await expect(store.getState().pushBranch('wt', '/repo')).rejects.toThrow('unresolved')
    await expect(store.getState().syncBranch('wt', '/repo')).rejects.toThrow('unresolved')
    expect(push).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    // A failed lookup retains the same unresolved state; no configured push fallback is admitted.
    await expect(store.getState().pushBranch('wt', '/repo')).rejects.toThrow('unresolved')
    for (const remoteName of ['contributor', 'other-repository']) {
      worktree.pushTarget = reviewTarget(
        remoteName,
        'feature',
        link === 'linkedPR' ? 'github' : 'gitlab'
      )
      await store.getState().pushBranch('wt', '/repo')
      expect(push).toHaveBeenLastCalledWith(
        expect.objectContaining({ pushTarget: worktree.pushTarget })
      )
      await expect(
        store
          .getState()
          .pushBranch('wt', '/repo', false, undefined, reviewTarget('origin', 'feature'))
      ).rejects.toThrow('changed')
    }
  }
)
