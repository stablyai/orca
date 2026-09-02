// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { useHostedReviewStackParent } from './useHostedReviewStackParent'

function makeReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 13741,
    title: 'Parent review',
    state: 'open',
    url: 'https://github.com/stablyai/orca/pull/13741',
    status: 'success',
    updatedAt: '2026-08-11T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

const baseOptions = {
  enabled: true,
  repoPath: '/repo/orca',
  repoId: 'repo-1',
  base: 'feature/parent',
  repoDefaultBase: 'main',
  head: 'feature/child'
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useHostedReviewStackParent', () => {
  it('debounces the active branch lookup and preserves repo routing context', async () => {
    vi.useFakeTimers()
    const fetchHostedReviewForBranch = vi.fn(async () => makeReview())
    const { result } = renderHook(() =>
      useHostedReviewStackParent({ ...baseOptions, fetchHostedReviewForBranch })
    )

    await act(async () => vi.advanceTimersByTime(299))
    expect(fetchHostedReviewForBranch).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTime(1))

    expect(fetchHostedReviewForBranch).toHaveBeenCalledWith('/repo/orca', 'feature/parent', {
      repoId: 'repo-1',
      active: true
    })
    expect(result.current).toEqual({
      number: 13741,
      url: 'https://github.com/stablyai/orca/pull/13741'
    })
  })

  it('looks up the worktree base branch a child forked from', async () => {
    vi.useFakeTimers()
    const fetchHostedReviewForBranch = vi.fn(async () => makeReview())
    const { result } = renderHook(() =>
      useHostedReviewStackParent({
        ...baseOptions,
        // The worktree was created off feature/parent, so eligibility reports it as
        // the default base; the repo default is still main and stacking still applies.
        base: 'feature/parent',
        repoDefaultBase: 'main',
        fetchHostedReviewForBranch
      })
    )

    await act(async () => vi.runAllTimers())

    expect(fetchHostedReviewForBranch).toHaveBeenCalledTimes(1)
    expect(result.current?.number).toBe(13741)
  })

  it.each([
    { base: 'origin/main', repoDefaultBase: 'main', head: 'feature/child' },
    { base: 'refs/heads/feature/child', repoDefaultBase: 'main', head: 'feature/child' },
    { base: '', repoDefaultBase: 'main', head: 'feature/child' }
  ])('skips ineligible base $base', async (options) => {
    vi.useFakeTimers()
    const fetchHostedReviewForBranch = vi.fn(async () => makeReview())
    renderHook(() =>
      useHostedReviewStackParent({
        ...baseOptions,
        ...options,
        fetchHostedReviewForBranch
      })
    )

    await act(async () => vi.runAllTimers())

    expect(fetchHostedReviewForBranch).not.toHaveBeenCalled()
  })

  it.each([
    makeReview({ provider: 'gitlab' }),
    makeReview({ state: 'closed' }),
    makeReview({ state: 'merged' })
  ])('rejects a non-open GitHub review', async (review) => {
    vi.useFakeTimers()
    const fetchHostedReviewForBranch = vi.fn(async () => review)
    const { result } = renderHook(() =>
      useHostedReviewStackParent({ ...baseOptions, fetchHostedReviewForBranch })
    )

    await act(async () => vi.runAllTimers())

    expect(result.current).toBeNull()
  })

  it.each(['open', 'draft'] as const)('accepts a %s GitHub review', async (state) => {
    vi.useFakeTimers()
    const fetchHostedReviewForBranch = vi.fn(async () => makeReview({ state }))
    const { result } = renderHook(() =>
      useHostedReviewStackParent({ ...baseOptions, fetchHostedReviewForBranch })
    )

    await act(async () => vi.runAllTimers())

    expect(result.current?.number).toBe(13741)
  })

  it('ignores a stale result after the base changes', async () => {
    vi.useFakeTimers()
    let resolveFirst: (review: HostedReviewInfo) => void = () => undefined
    let resolveSecond: (review: HostedReviewInfo) => void = () => undefined
    const first = new Promise<HostedReviewInfo>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<HostedReviewInfo>((resolve) => {
      resolveSecond = resolve
    })
    const fetchHostedReviewForBranch = vi.fn((_repoPath: string, branch: string) =>
      branch === 'feature/first' ? first : second
    )
    const { result, rerender } = renderHook(
      ({ base }) =>
        useHostedReviewStackParent({ ...baseOptions, base, fetchHostedReviewForBranch }),
      { initialProps: { base: 'feature/first' } }
    )

    await act(async () => vi.advanceTimersByTime(300))
    rerender({ base: 'feature/second' })
    await act(async () => vi.advanceTimersByTime(300))
    await act(async () => resolveSecond(makeReview({ number: 22, url: 'https://example.test/22' })))
    expect(result.current?.number).toBe(22)

    await act(async () => resolveFirst(makeReview({ number: 11, url: 'https://example.test/11' })))
    expect(result.current?.number).toBe(22)
  })
})
