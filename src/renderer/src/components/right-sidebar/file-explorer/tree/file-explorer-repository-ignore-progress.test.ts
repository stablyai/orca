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
          await new Promise<void>((resolve) => {
            // ast-grep-ignore: test-no-real-time-wait -- Fake time models an in-flight Git read; no wall-clock wait.
            setTimeout(resolve, 1500)
          })
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

it.each([200, 2000])(
  'encodes each finite byte-wave candidate once at %i normal long paths',
  async (count) => {
    vi.useFakeTimers()
    const prefix = Array.from({ length: 30 }, () => 'a'.repeat(98)).join('/')
    const paths = Array.from(
      { length: count },
      (_, index) => `repo/${prefix}/p${String(index).padStart(5, '0')}`
    )
    const sent: string[][] = []
    let sources: readonly ExplorerRepositorySource[] = []
    const observer = new FileExplorerRepositoryObserver(
      async (request) => {
        if (request.repositoryIntent === 'ignored') {
          sent.push(request.repositoryQueryPaths!)
          await new Promise<void>((resolve) => {
            // ast-grep-ignore: test-no-real-time-wait -- Fake time models an in-flight Git read; no wall-clock wait.
            setTimeout(resolve, 1)
          })
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
    let encodings = 0
    let encodedBytes = 0
    const encode = TextEncoder.prototype.encode
    const spy = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
      this: TextEncoder,
      input
    ) {
      const result = encode.call(this, input)
      if (input?.startsWith(prefix)) {
        encodings++
        encodedBytes += result.byteLength
      }
      return result
    })
    try {
      observer.setFrontier([{ path: 'repo', marker: true }], ['repo'])
      observer.setDemand(paths)
      observer.setVisible(true)
      await vi.advanceTimersByTimeAsync(0)
      const lookahead = sent[0].length < count ? paths[sent[0].length] : undefined
      observer.setDemand(paths.filter((path) => path !== paths.at(-1) && path !== lookahead))
      observer.setDemand(paths.slice(0, -1))
      await vi.advanceTimersByTimeAsync(5000)
    } finally {
      spy.mockRestore()
    }
    expect(encodings).toBe(count)
    expect(encodedBytes).toBe(count * encode.call(new TextEncoder(), paths[0].slice(5)).byteLength)
    expect(sources[0].ignored.size).toBe(count - 1)
    const counts = new Map<string, number>()
    for (const query of sent) {
      expect(query.length).toBeLessThanOrEqual(2000)
      expect(
        query.reduce((sum, path) => sum + encode.call(new TextEncoder(), path).byteLength + 1, 0)
      ).toBeLessThanOrEqual(1024 * 1024)
      for (const path of query) {
        counts.set(path, (counts.get(path) ?? 0) + 1)
      }
    }
    expect(paths.slice(0, -1).every((path) => counts.get(path.slice(5)) === 1)).toBe(true)
    observer.dispose()
  }
)

it.each(['unknown', 'read-error'] as const)(
  'keeps %s status retries scoped to their eligible input',
  async (mode) => {
    vi.useFakeTimers()
    const calls: number[] = []
    let recovered = false
    let sources: readonly ExplorerRepositorySource[] = []
    const observer = new FileExplorerRepositoryObserver(
      async (request) => {
        if (request.repositoryIntent === 'ignored') {
          return [{ path: 'repo', kind: 'repository', ignoredPaths: ['keep'] }]
        }
        calls.push(Date.now())
        return mode === 'unknown' && !recovered
          ? [{ path: 'repo', kind: 'unknown' }]
          : [
              {
                path: 'repo',
                kind: 'repository',
                status: {
                  entries: [],
                  conflictOperation: 'unknown',
                  ...(!recovered ? { readError: 'busy' } : {})
                }
              }
            ]
      },
      (next) => {
        sources = next
      }
    )
    observer.setFrontier([{ path: 'repo', marker: true }], ['repo'])
    observer.setDemand(['repo/keep'])
    observer.setVisible(true)
    await vi.advanceTimersByTimeAsync(1000)
    for (let index = 0; index < 61; index++) {
      observer.invalidate(index % 2 ? 'repo/file' : 'repo/child-directory', index % 2 === 0)
      await vi.advanceTimersByTimeAsync(1000)
    }
    if (mode === 'unknown') {
      expect(calls).toHaveLength(2)
      expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(60_000)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toHaveLength(3)
      expect(calls[2] - calls[1]).toBeGreaterThanOrEqual(60_000)
    } else {
      expect(calls.length).toBeGreaterThanOrEqual(20)
    }
    expect(sources.map((source) => source.path)).toEqual(['repo'])
    expect(sources[0].ignored.get('keep')).toBe(true)
    recovered = true
    const before = calls.length
    observer.invalidate('repo/.git')
    await vi.advanceTimersByTimeAsync(4000)
    expect(calls.length).toBeGreaterThan(before)
    observer.dispose()
  }
)
