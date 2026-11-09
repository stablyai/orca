// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { useAppStore } from '@/store'
import { useRepoSlugIndex } from './repo-slug-index'
import { REPO_SLUG_FAILURE_TTL_MS, clearRepoSlugCacheValues } from './repo-slug-cache'

const repoSlug = vi.fn()

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

const initialState = useAppStore.getInitialState()

function setRepos(repos: Repo[]): void {
  useAppStore.setState({ ...initialState, repos, settings: initialState.settings }, true)
}

beforeEach(() => {
  clearRepoSlugCacheValues()
  repoSlug.mockReset()
  // Resolve origin through preload; fork aliases read only existing repo.upstream metadata.
  Object.assign(window, { api: { gh: { repoSlug } } })
})

afterEach(() => {
  // Unmount hooks before DOM teardown or deferred React work throws window-is-undefined errors.
  cleanup()
  setRepos([])
})

describe('useRepoSlugIndex failure retry', () => {
  afterEach(() => vi.useRealTimers())

  it('re-resolves a failed slug after the failure TTL and stops once unmounted', async () => {
    vi.useFakeTimers()
    const repo = makeRepo({ id: 'flaky' })
    setRepos([repo])
    // Negative-cached non-GitHub results must arm bounded retries.
    repoSlug.mockResolvedValueOnce(null)

    const { result } = renderHook(() => useRepoSlugIndex())
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    expect(result.current.ready).toBe(true)
    expect(result.current.lookupSlug('acme/widgets')).toEqual([])
    expect(repoSlug).toHaveBeenCalledTimes(1)

    repoSlug.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    await act(async () => void (await vi.advanceTimersByTimeAsync(REPO_SLUG_FAILURE_TTL_MS + 10)))
    expect(repoSlug.mock.calls.length).toBeGreaterThan(1)
    expect(result.current.lookupSlug('acme/widgets')).toEqual([repo])
  })

  it('clears the pending retry timer on unmount', async () => {
    vi.useFakeTimers()
    setRepos([makeRepo({ id: 'flaky' })])
    // Permanent failures keep retries armed; assert cleanup because one leaked timer per project row would accumulate.
    repoSlug.mockResolvedValue(null)

    const { unmount } = renderHook(() => useRepoSlugIndex())
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    const armedCount = vi.getTimerCount()

    unmount()
    expect(vi.getTimerCount()).toBeLessThan(armedCount)
  })
})
