import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/types'
import { rememberRepoSlug } from './repo-slug-cache'
import {
  buildRepoSlugIndexForTests,
  buildSharedRepoSlugIndexForTests,
  clearRepoSlugCache,
  clearRepoSlugCacheEntry,
  getRepoSlugResolutionStateSizesForTests,
  REPO_SLUG_RESOLUTION_CONCURRENCY
} from './repo-slug-index'

function repo(id: string): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    executionHostId: 'local'
  }
}

describe('repo slug resolution retention', () => {
  beforeEach(() => clearRepoSlugCache())

  it('does not retain invalidation state for removed repo ids', () => {
    for (let index = 0; index < 3_000; index += 1) {
      const repoId = `repo-${index}`
      rememberRepoSlug(`local:${repoId}`, `owner/${repoId}`)
      clearRepoSlugCacheEntry(repoId)
    }

    expect(getRepoSlugResolutionStateSizesForTests()).toEqual({ inFlight: 0, tokens: 0 })
  })

  it('shares one in-flight index build across identical consumers', async () => {
    const repos = Array.from({ length: 20 }, (_, index) => repo(`repo-${index}`))
    let calls = 0
    const resolver = async (candidate: Repo): Promise<string> => {
      calls += 1
      return `owner/${candidate.id}`
    }

    const first = buildSharedRepoSlugIndexForTests(repos, resolver)
    const second = buildSharedRepoSlugIndexForTests(repos, resolver)
    const [firstIndex, secondIndex] = await Promise.all([first, second])

    expect(calls).toBe(repos.length)
    expect(firstIndex).toBe(secondIndex)
  })

  it('cancels queued work when a shared build is superseded', async () => {
    const staleResolver = vi.fn(async (candidate: Repo) => `owner/${candidate.id}`)
    const currentResolver = vi.fn(async (candidate: Repo) => `owner/${candidate.id}`)
    const stale = buildSharedRepoSlugIndexForTests([repo('stale')], staleResolver)
    const current = buildSharedRepoSlugIndexForTests([repo('current')], currentResolver)

    const [staleResult, currentResult] = await Promise.allSettled([stale, current])

    expect(staleResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'Repo slug index resolution was cancelled.' })
    })
    expect(currentResult).toMatchObject({ status: 'fulfilled' })
    expect(staleResolver).not.toHaveBeenCalled()
    expect(currentResolver).toHaveBeenCalledTimes(1)
  })

  it('shares the fixed worker pool across overlapping index builds', async () => {
    const repos = Array.from({ length: REPO_SLUG_RESOLUTION_CONCURRENCY * 3 }, (_, index) =>
      repo(`first-${index}`)
    )
    const overlappingRepos = Array.from(
      { length: REPO_SLUG_RESOLUTION_CONCURRENCY * 3 },
      (_, index) => repo(`second-${index}`)
    )
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let active = 0
    let peak = 0
    let started = 0

    const resolver = async (candidate: Repo): Promise<string> => {
      active += 1
      started += 1
      peak = Math.max(peak, active)
      await gate
      active -= 1
      return `owner/${candidate.id}`
    }
    const building = buildRepoSlugIndexForTests(repos, resolver)
    const overlappingBuild = buildRepoSlugIndexForTests(overlappingRepos, resolver)

    await Promise.resolve()
    expect(started).toBe(REPO_SLUG_RESOLUTION_CONCURRENCY)
    expect(peak).toBe(REPO_SLUG_RESOLUTION_CONCURRENCY)
    release()

    const [index, overlappingIndex] = await Promise.all([building, overlappingBuild])
    expect(index.size).toBe(repos.length)
    expect(overlappingIndex.size).toBe(overlappingRepos.length)
    expect(peak).toBe(REPO_SLUG_RESOLUTION_CONCURRENCY)
  })

  it('preserves input ordering when resolutions settle out of order', async () => {
    const repos = ['a', 'b', 'c', 'd'].map(repo)
    const completions = new Map<string, (slug: string | null) => void>()
    const building = buildRepoSlugIndexForTests(
      repos,
      (candidate) =>
        new Promise((resolve) => {
          completions.set(candidate.id, resolve)
        })
    )

    await Promise.resolve()
    completions.get('d')?.('owner/shared')
    completions.get('c')?.(null)
    completions.get('b')?.('owner/shared')
    completions.get('a')?.('owner/other')

    const index = await building
    expect(Array.from(index.keys())).toEqual(['owner/other', 'owner/shared'])
    expect(index.get('owner/shared')?.map((candidate) => candidate.id)).toEqual(['b', 'd'])
  })
})
