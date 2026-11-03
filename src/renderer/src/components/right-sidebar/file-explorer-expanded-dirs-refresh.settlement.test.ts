import { expect, it, vi } from 'vitest'
import type { DirCache } from './file-explorer-types'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import { refreshFileExplorerExpandedDirs } from './file-explorer-expanded-dirs-refresh'
import {
  createLoadingDirPathsRecorder,
  hasPropertyKey,
  entry,
  emptyReadError,
  deferredListing,
  flushWorkers
} from './file-explorer-expanded-refresh-test-support'

it.each([100, 1000])(
  'bounds actual protected Wave loading work and prompt retired outcomes at %i claims',
  async (count) => {
    const cap = 16
    const paths = Array.from({ length: count }, (_, i) => `/repo/d${i}`)
    const gates = paths.map(() => deferredListing())
    const tracker = createFileExplorerDirLoadTracker()
    let allowed = true,
      loading: ReadonlySet<string> = new Set(),
      cache: Record<string, DirCache> = {}
    let updaters = 0,
      members = 0,
      changedSets = 0,
      populationMembers = 0,
      populationScans = 0
    const measured = (value: ReadonlySet<string>): ReadonlySet<string> =>
      new Proxy(value, {
        get(target, key) {
          if (key === Symbol.iterator) {
            return function* () {
              for (const path of target) {
                members++
                yield path
              }
            }
          }
          const property = hasPropertyKey(target, key) ? target[key] : undefined
          return typeof property === 'function' ? property.bind(target) : property
        }
      })
    const readDirectory = vi.fn((path: string) => gates[paths.indexOf(path)].promise)
    const refresh = refreshFileExplorerExpandedDirs({
      dirs: paths.map((dirPath) => ({ dirPath, depth: 0 })),
      worktreePath: '/repo',
      dirLoadTracker: tracker,
      setDirCache: (update) => {
        cache = typeof update === 'function' ? update(cache) : update
      },
      updateLoadingDirPaths: (update) => {
        updaters++
        const next = update(loading)
        if (next !== loading) {
          changedSets++
          loading = measured(next)
        }
      },
      readDirectory,
      maxConcurrentReads: cap,
      canCommit: () => allowed
    })
    const tokens = paths.map((path) => tracker.get(path)!)
    const tokenSet = new Set(tokens)
    const outcomes = new Map<string, string>()
    tokens.forEach((token) => {
      void token.promise.then((outcome) => outcomes.set(token.dirPath, outcome))
    })
    const originalValues = Map.prototype.values
    const values = vi.spyOn(Map.prototype, 'values').mockImplementation(function (
      this: Map<unknown, (typeof tokens)[number]>
    ) {
      const iterator = originalValues.call(this)
      const next = iterator.next.bind(iterator)
      let counted = false
      iterator.next = (...args) => {
        const result = next(...args)
        if (!result.done && tokenSet.has(result.value)) {
          if (!counted) {
            populationScans++
            counted = true
          }
          populationMembers++
        }
        return result
      }
      return iterator
    })
    try {
      expect(readDirectory).toHaveBeenCalledTimes(cap)
      updaters = members = changedSets = 0
      allowed = false
      gates[0].resolve({ entries: [entry('declined')], operationOwner: { kind: 'local' } })
      // Queued callbacks still use the real concurrency executor; await their logical results, not held transport.
      await Promise.all([tokens[0].promise, ...tokens.slice(cap).map((token) => token.promise)])
      await flushWorkers()
      expect(readDirectory).toHaveBeenCalledTimes(cap)
      expect(outcomes.size).toBe(count - cap + 1)
      expect(tokens.slice(1, cap).every((token) => tracker.isCurrent(token))).toBe(true)
      expect(loading.size).toBe(cap - 1)
      expect([...outcomes.values()].every((outcome) => outcome === 'superseded')).toBe(true)
      // The allowed singleton-first/group-second design copies N + (N-1), rather than N+(N-1)+...+K.
      expect(members).toBeLessThanOrEqual(2 * count - 1)
      expect(changedSets).toBeLessThanOrEqual(2)
      expect(updaters).toBe(count - cap + 2)
      expect(populationScans).toBeLessThanOrEqual(1)
      expect(populationMembers).toBeLessThanOrEqual(count)
      gates
        .slice(1, cap)
        .forEach((gate) => gate.resolve({ entries: [], operationOwner: { kind: 'local' } }))
      expect(await refresh).toBe(false)
      expect(loading.size).toBe(0)
      expect(outcomes.size).toBe(count)
      // K-1 real singleton outcomes; include final inventory and no-op updater work.
      expect(members).toBeLessThanOrEqual(2 * count - 1 + (cap * (cap - 1)) / 2)
      expect(populationMembers).toBeLessThanOrEqual(2 * count)
      expect(updaters).toBe(count + 2)
      expect(Object.values(cache).every((value) => value.children.length === 0)).toBe(true)
    } finally {
      values.mockRestore()
    }
  }
)

it('groups ready success declines while publishing ready terminal errors before logical settlement', async () => {
  const tracker = createFileExplorerDirLoadTracker()
  const gates = Array.from({ length: 4 }, () => deferredListing())
  const paths = gates.map((_, i) => `/repo/d${i}`)
  let allowed = true,
    loading: ReadonlySet<string> = new Set(),
    cache: Record<string, DirCache> = {}
  let copies = 0,
    updaters = 0
  const refresh = refreshFileExplorerExpandedDirs({
    dirs: paths.map((dirPath) => ({ dirPath, depth: 0 })),
    worktreePath: '/repo',
    dirLoadTracker: tracker,
    setDirCache: (update) => {
      cache = typeof update === 'function' ? update(cache) : update
    },
    updateLoadingDirPaths: (update) => {
      updaters++
      const next = update(loading)
      if (next !== loading) {
        copies++
      }
      loading = next
    },
    readDirectory: (path) => gates[paths.indexOf(path)].promise,
    maxConcurrentReads: 4,
    canCommit: () => allowed
  })
  const tokens = paths.map((path) => tracker.get(path)!)
  gates[0].resolve({ entries: [entry('declined-a')], operationOwner: { kind: 'local' } })
  gates[1].resolve({ entries: [entry('declined-b')], operationOwner: { kind: 'local' } })
  gates[2].reject(emptyReadError())
  await flushWorkers()
  copies = updaters = 0
  allowed = false
  expect(await tracker.observe(tokens[2])).toBe('root-unreadable')
  expect(cache[paths[2]].error).toBe('')
  expect(await tokens[0].promise).toBe('superseded')
  expect(await tokens[1].promise).toBe('superseded')
  expect(loading.has(paths[3])).toBe(true)
  expect(copies).toBe(2) // one declined group and one terminal publication group
  expect(updaters).toBe(5) // both group updaters and all three owned no-op cleanups
  gates[3].resolve({ entries: [], operationOwner: { kind: 'local' } })
  await refresh
})

it.each([100, 1000])(
  'skips obsolete Wave entry construction at width %i with live and error controls',
  async (width) => {
    for (const action of [
      'abort',
      'reset',
      'replace',
      'protected',
      'current',
      'read-error',
      'conversion-error'
    ] as const) {
      const tracker = createFileExplorerDirLoadTracker(),
        controller = new AbortController(),
        held = deferredListing()
      const loading = createLoadingDirPathsRecorder()
      let allowed = true,
        visits = 0,
        cache: Record<string, DirCache> = {}
      const entries = Array.from({ length: width }, (_, i) => entry(`f${i}`))
      const measured = new Proxy(entries, {
        get(target, key) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            visits++
            if (action === 'conversion-error') {
              throw emptyReadError()
            }
          }
          return hasPropertyKey(target, key) ? target[key] : undefined
        }
      })
      const refresh = refreshFileExplorerExpandedDirs({
        dirs: [{ dirPath: '/repo/a', depth: 0 }],
        worktreePath: '/repo',
        dirLoadTracker: tracker,
        setDirCache: (update) => {
          cache = typeof update === 'function' ? update(cache) : update
        },
        updateLoadingDirPaths: loading.updateLoadingDirPaths,
        readDirectory: () => held.promise,
        maxConcurrentReads: 16,
        signal: controller.signal,
        canCommit: () => allowed
      })
      const token = tracker.get('/repo/a')!
      let successor: ReturnType<typeof tracker.begin> | undefined
      if (action === 'abort') {
        controller.abort()
      }
      if (action === 'reset') {
        tracker.reset()
      }
      if (action === 'replace') {
        successor = tracker.begin('/repo/a')
      }
      if (action === 'protected') {
        allowed = false
      }
      if (action === 'read-error') {
        held.reject(emptyReadError())
      } else {
        held.resolve({ entries: measured, operationOwner: { kind: 'local' } })
      }
      await refresh
      await flushWorkers() // aborted aggregate may precede its handled physical continuation
      const outcome = await token.promise
      if (action === 'current') {
        expect(visits).toBeGreaterThanOrEqual(width)
        expect(cache['/repo/a'].children).toHaveLength(width)
        expect(outcome).toBe('refreshed')
      } else if (action === 'read-error' || action === 'conversion-error') {
        expect(cache['/repo/a'].error).toBe('')
        expect(outcome).toBe('root-unreadable')
        expect(visits).toBe(action === 'conversion-error' ? 1 : 0)
      } else {
        expect({ action, visits }).toEqual({ action, visits: 0 })
        expect(cache['/repo/a'].children).toEqual([])
        expect(outcome).toBe('superseded')
      }
      if (successor) {
        expect(tracker.isCurrent(successor)).toBe(true)
        tracker.retire(successor)
      }
    }
  }
)

it('drains every owned record and listener after commit and multiple cleanup exceptions with held transport', async () => {
  const tracker = createFileExplorerDirLoadTracker(),
    begin = tracker.begin
  const callbackError = new Error('commit callback'),
    cleanupError = new Error('record cleanup')
  const beginSpy = vi.spyOn(tracker, 'begin').mockImplementation((path, cleanup, flush) =>
    begin(
      path,
      () => {
        cleanup?.()
        if (path === '/repo/b' || path === '/repo/c') {
          throw cleanupError
        }
      },
      flush
    )
  )
  const controller = new AbortController(),
    remove = vi.spyOn(controller.signal, 'removeEventListener')
  const paths = ['a', 'b', 'c', 'd'].map((name) => `/repo/${name}`),
    gates = paths.map(() => deferredListing())
  const { updateLoadingDirPaths, isLoading } = createLoadingDirPathsRecorder()
  const outcomes: string[] = []
  let aggregate: unknown,
    finished = false
  const refresh = refreshFileExplorerExpandedDirs({
    dirs: paths.map((dirPath) => ({ dirPath, depth: 0 })),
    worktreePath: '/repo',
    dirLoadTracker: tracker,
    setDirCache: () => {},
    updateLoadingDirPaths,
    readDirectory: (path) => gates[paths.indexOf(path)].promise,
    maxConcurrentReads: 4,
    signal: controller.signal,
    onDirCommitted: () => {
      throw callbackError
    }
  }).then(
    () => {
      finished = true
    },
    (error) => {
      aggregate = error
      finished = true
    }
  )
  const tokens = paths.map((path) => tracker.get(path)!)
  tokens.forEach((token) => {
    void token.promise.then((outcome) => outcomes.push(outcome))
  })
  void tracker.observe(tokens[0])
  gates[0].resolve({ entries: [entry('ready')], operationOwner: { kind: 'local' } })
  await flushWorkers()
  expect(finished).toBe(true)
  expect(aggregate).toBe(callbackError)
  expect(outcomes).toEqual(['superseded', 'superseded', 'superseded', 'superseded'])
  expect(paths.every((path) => !tracker.get(path) && !isLoading(path))).toBe(true)
  expect(remove.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1)
  const successor = tracker.begin('/repo/a')
  gates[1].reject(new Error('late read'))
  gates[2].resolve({ entries: [], operationOwner: { kind: 'local' } })
  gates[3].reject(new Error('late read'))
  await flushWorkers()
  expect(tracker.isCurrent(successor)).toBe(true)
  tracker.finish(successor, 'refreshed')
  expect(await successor.promise).toBe('refreshed')
  await refresh
  beginSpy.mockRestore()
  remove.mockRestore()
})
