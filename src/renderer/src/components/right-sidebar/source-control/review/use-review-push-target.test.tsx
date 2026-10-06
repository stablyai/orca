// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useSourceControlReviewPushTarget } from './use-review-push-target'

beforeEach(() => vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('resolves a linked review push target only for a visible branch needing it', () => {
  const ensure = vi.fn()
  const input = {
    activeWorktree: makeWorktree({ id: 'worktree', repoId: 'repo' }),
    activeWorktreeId: 'worktree',
    ensureHostedReviewPushTarget: ensure,
    hasResolvableReviewPushTargetLink: true,
    isBranchVisible: false,
    isFolder: false
  }
  const hook = renderHook(({ input }) => useSourceControlReviewPushTarget(input), {
    initialProps: { input }
  })
  expect(ensure).not.toHaveBeenCalled()
  hook.rerender({ input: { ...input, isBranchVisible: true } })
  expect(ensure).toHaveBeenCalledExactlyOnceWith('worktree')
  hook.rerender({
    input: { ...input, isBranchVisible: true, activeWorktree: { ...input.activeWorktree } }
  })
  expect(ensure).toHaveBeenCalledOnce()
})

it('does not resolve a linked target while the window is hidden', () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const ensure = vi.fn()
  renderHook(() =>
    useSourceControlReviewPushTarget({
      activeWorktree: makeWorktree({ id: 'worktree', repoId: 'repo' }),
      activeWorktreeId: 'worktree',
      ensureHostedReviewPushTarget: ensure,
      hasResolvableReviewPushTargetLink: true,
      isBranchVisible: true,
      isFolder: false
    })
  )
  expect(ensure).not.toHaveBeenCalled()
})
