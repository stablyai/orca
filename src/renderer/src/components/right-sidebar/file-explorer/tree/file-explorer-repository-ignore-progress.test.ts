import { afterEach, expect, it, vi } from 'vitest'
import {
  FileExplorerRepositoryObserver,
  type ExplorerRepositorySource
} from './file-explorer-repository-observer'

afterEach(() => vi.useRealTimers())

it.each([1, 10])(
  'finishes %i captured ignore chunks while demand changes without replay or stale membership',
  async (chunks) => {
    vi.useFakeTimers()
    const requests: string[][] = []
    let aborted = 0
    let sources: readonly ExplorerRepositorySource[] = []
    const observer = new FileExplorerRepositoryObserver(
      async (request, signal) => {
        if (request.repositoryIntent === 'ignored') {
          const query = request.repositoryQueryPaths!
          const first = requests.length === 0
          requests.push(query)
          signal.addEventListener(
            'abort',
            () => {
              aborted++
            },
            { once: true }
          )
          await new Promise((resolve) => setTimeout(resolve, 1500))
          return [{ path: 'repo', kind: 'repository', ignoredPaths: first ? ['p00000'] : [] }]
        }
        return [
          {
            path: 'repo',
            kind: 'repository',
            status: { entries: [], conflictOperation: 'unknown' }
          }
        ]
      },
      (next) => {
        sources = next
      }
    )
    const base = Array.from(
      { length: chunks * 2000 },
      (_, index) => `repo/p${String(index).padStart(5, '0')}`
    )
    observer.setFrontier([{ path: 'repo', marker: true }], ['repo'])
    observer.setDemand(base)
    observer.setVisible(true)
    await vi.advanceTimersByTimeAsync(1000)
    observer.setDemand(base.slice(1))
    observer.setDemand(base)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sources[0].ignored.has('p00000')).toBe(false)
    const added: string[] = []
    for (let index = 0; index < 20; index++) {
      added.push(`repo/new${index}`)
      observer.setDemand([...base, ...added])
      await vi.advanceTimersByTimeAsync(1000)
    }
    await vi.advanceTimersByTimeAsync(29_000)
    const counts = new Map<string, number>()
    for (const query of requests) {
      for (const path of query) {
        counts.set(path, (counts.get(path) ?? 0) + 1)
      }
    }
    expect(counts.get('p00000')).toBe(2)
    expect(base.slice(1).every((path) => counts.get(path.slice(5)) === 1)).toBe(true)
    expect(
      [...base, ...added].every((path) => sources[0].ignored.get(path.slice(5)) === false)
    ).toBe(true)
    expect(aborted).toBe(0)
    observer.invalidate('repo/.gitignore')
    await vi.advanceTimersByTimeAsync(1000)
    const before = requests.length
    observer.setDemand([])
    await vi.advanceTimersByTimeAsync(5000)
    expect(requests).toHaveLength(before)
    expect(sources[0].ignored.size).toBe(0)
    observer.dispose()
  }
)

it.each(['unknown', 'throw'] as const)(
  'backs off exact %s failures while new paths and full safety make progress',
  async (failure) => {
    vi.useFakeTimers()
    const requests: { paths: string[]; at: number }[] = []
    let recover = false
    let sources: readonly ExplorerRepositorySource[] = []
    const observer = new FileExplorerRepositoryObserver(
      async (request) => {
        if (request.repositoryIntent === 'ignored') {
          const paths = request.repositoryQueryPaths!
          requests.push({ paths, at: Date.now() })
          if (!recover && paths.includes('bad')) {
            if (failure === 'throw') {
              throw new Error('offline')
            }
            return [{ path: 'repo', kind: 'unknown' }]
          }
          return [{ path: 'repo', kind: 'repository', ignoredPaths: [] }]
        }
        return [
          {
            path: 'repo',
            kind: 'repository',
            status: { entries: [], conflictOperation: 'unknown' }
          }
        ]
      },
      (next) => {
        sources = next
      }
    )
    observer.setFrontier([{ path: 'repo', marker: true }], ['repo'])
    observer.setDemand(['repo/ok'])
    observer.setVisible(true)
    await vi.advanceTimersByTimeAsync(1000)
    const paths = ['repo/ok', 'repo/bad']
    observer.setDemand(paths)
    await vi.advanceTimersByTimeAsync(4000)
    for (let index = 0; index < 10; index++) {
      paths.push(`repo/new${index}`)
      observer.setDemand([...paths])
      observer.invalidate('repo/content.txt')
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(requests.filter((request) => request.paths.includes('bad'))).toHaveLength(1)
    expect(sources[0].ignored.get('new0')).toBe(false)
    await vi.advanceTimersByTimeAsync(50_000)
    const attempts = requests.filter((request) => request.paths.includes('bad'))
    expect(attempts).toHaveLength(2)
    expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(60_000)
    expect(attempts[1].paths).toEqual(['bad'])
    expect(requests.filter((request) => request.paths.includes('ok'))).toHaveLength(2)
    recover = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sources[0].ignored.get('bad')).toBe(false)
    observer.dispose()
  }
)
