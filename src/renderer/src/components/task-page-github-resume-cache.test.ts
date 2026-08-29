import { describe, expect, it } from 'vitest'
import {
  buildTaskPageGitHubResumeContextKey,
  createTaskPageResumePageCache,
  TASK_PAGE_GITHUB_RESUME_CACHE_LIMIT
} from './task-page-github-resume-cache'

describe('task page GitHub resume cache', () => {
  it('isolates entries by full list context', () => {
    const cache = createTaskPageResumePageCache<number>()
    const first = buildTaskPageGitHubResumeContextKey({
      selectedReposKey: 'local:repo-a',
      query: 'is:pr',
      pageSize: 30
    })
    const second = buildTaskPageGitHubResumeContextKey({
      selectedReposKey: 'ssh:host-a:repo-a',
      query: 'is:pr',
      pageSize: 30
    })

    cache.write(first, 2, [1])
    cache.write(second, 2, [2])

    expect(cache.read(first, 2)?.items).toEqual([1])
    expect(cache.read(second, 2)?.items).toEqual([2])
  })

  it('evicts the least recently used page at the global cap', () => {
    const cache = createTaskPageResumePageCache<number>()
    for (let page = 0; page < TASK_PAGE_GITHUB_RESUME_CACHE_LIMIT; page += 1) {
      cache.write('scope', page, [page], page)
    }
    expect(cache.read('scope', 0, 10)?.items).toEqual([0])

    cache.write('scope', TASK_PAGE_GITHUB_RESUME_CACHE_LIMIT, [5], 11)

    expect(cache.size()).toBe(TASK_PAGE_GITHUB_RESUME_CACHE_LIMIT)
    expect(cache.read('scope', 1, 12)).toBeNull()
    expect(cache.read('scope', 0, 12)?.items).toEqual([0])
  })

  it('retains only five payloads after all 28 pages are visited', () => {
    const cache = createTaskPageResumePageCache<number>()

    for (let page = 0; page < 28; page += 1) {
      cache.write('scope', page, [page], page)
    }

    expect(cache.size()).toBe(5)
    expect(cache.read('scope', 22, 28)).toBeNull()
    expect(cache.read('scope', 23, 28)?.items).toEqual([23])
    expect(cache.read('scope', 27, 28)?.items).toEqual([27])
  })

  it('expires entries after the inactivity window', () => {
    const cache = createTaskPageResumePageCache<number>({ ttlMs: 100 })
    cache.write('scope', 4, [4], 0)
    expect(cache.read('scope', 4, 99)?.items).toEqual([4])
    expect(cache.read('scope', 4, 198)?.items).toEqual([4])
    expect(cache.read('scope', 4, 298)).toBeNull()
  })

  it('copies page arrays at the cache boundary', () => {
    const cache = createTaskPageResumePageCache<number>()
    const source = [1, 2]
    cache.write('scope', 0, source)
    source.push(3)

    const firstRead = cache.read('scope', 0)
    firstRead?.items.push(4)

    expect(cache.read('scope', 0)?.items).toEqual([1, 2])
  })
})
