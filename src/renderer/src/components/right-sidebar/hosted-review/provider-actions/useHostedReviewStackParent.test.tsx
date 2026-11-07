// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
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
