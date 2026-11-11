// @vitest-environment happy-dom
import { useEffect, useMemo, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  FileExplorerRepositoryObserver,
  type ExplorerRepositorySource
} from './file-explorer-repository-observer'
import type { ExplorerRepositoryRead } from './file-explorer-repository-source'
import { useFileExplorerVisibleRowProjection } from './useFileExplorerVisibleRowProjection'
import type { DirCache } from './file-explorer-types'

const { rootIgnored } = vi.hoisted(() => ({ rootIgnored: [] }))
vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { showGitIgnoredFiles: true } })
}))
vi.mock('./use-file-explorer-ignored-paths', () => ({
  useFileExplorerIgnoredPaths: () => rootIgnored
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function mountProjection(count: number, read: ExplorerRepositoryRead) {
  const paths = Array.from(
    { length: count },
    (_, index) => `repo/wave${String(index).padStart(5, '0')}`
  )
  const node = (relativePath: string, isDirectory = false) => ({
    name: relativePath.split('/').at(-1)!,
    relativePath,
    path: `/w/${relativePath}`,
    isDirectory,
    depth: 0
  })
  const cache: Record<string, DirCache> = {
    '/w': { children: [node('repo', true)] },
    '/w/repo': { children: paths.map((path) => node(path)) }
  }
  const expanded = new Set(['/w/repo'])
  const publications: ReadonlyMap<string, boolean>[] = []
  const projections = new Set<object>()
  let observer!: FileExplorerRepositoryObserver
  const hook = renderHook(
    ({ visible }) => {
      const [sources, setSources] = useState<readonly ExplorerRepositorySource[]>([])
      const instance = useMemo(
        () =>
          new FileExplorerRepositoryObserver(read, (next) => {
            const answers = next[0]?.ignored
            if (answers && publications.at(-1) !== answers) {
              publications.push(answers)
            }
            setSources(next)
          }),
        []
      )
      observer = instance
      useEffect(() => {
        instance.setFrontier([{ path: 'repo', marker: true }], ['repo'])
        instance.setVisible(visible)
      }, [instance, visible])
      useEffect(() => () => instance.dispose(), [instance])
      const setDemand = useMemo(() => instance.setDemand.bind(instance), [instance])
      const { rowProjection } = useFileExplorerVisibleRowProjection(
        'folder:w',
        visible ? '/w' : null,
        cache,
        expanded,
        false,
        true,
        null,
        null,
        visible ? '/w' : null,
        { sources, setDemand }
      )
      useEffect(() => {
        projections.add(rowProjection)
      }, [rowProjection])
      return sources
    },
    { initialProps: { visible: true } }
  )
  return { ...hook, observer, publications, projections }
}

it.each([1, 10])(
  'publishes %i finite chunks once through the actual projection',
  async (chunks) => {
    vi.useFakeTimers()
    const count = chunks * 2000
    let ignored = true
    let reads = 0
    let start!: () => void
    const fixture = mountProjection(count, async (request) => {
      if (request.repositoryIntent === 'ignored') {
        reads++
        if (reads === 1) {
          await new Promise<void>((resolve) => {
            start = resolve
          })
        }
        await new Promise<void>((resolve) => {
          // ast-grep-ignore: test-no-real-time-wait -- Fake time models an in-flight Git read; no wall-clock wait.
          setTimeout(resolve, 10)
        })
        return [
          {
            path: 'repo',
            kind: 'repository',
            ignoredPaths: ignored ? request.repositoryQueryPaths! : []
          }
        ]
      }
      return [
        { path: 'repo', kind: 'repository', status: { entries: [], conflictOperation: 'unknown' } }
      ]
    })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    const initialPublications = fixture.publications.length
    fixture.projections.clear()
    act(() => start())
    // Count actual answer-map traversal, excluding token, tree and source maps.
    let copied = 0
    const entries = Map.prototype[Symbol.iterator]
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (
      this: Map<string, unknown>
    ) {
      for (const entry of entries.call(this)) {
        if (
          typeof entry[0] === 'string' &&
          entry[0].startsWith('wave') &&
          typeof entry[1] === 'boolean'
        ) {
          copied++
        }
        yield entry
      }
      return undefined
    })
    for (let index = 0; index < chunks; index++) {
      await act(() => vi.advanceTimersByTimeAsync(10))
    }
    expect(reads).toBe(chunks)
    expect(fixture.result.current[0].ignored.size).toBe(count)
    expect(fixture.publications.length - initialPublications).toBe(1)
    expect(fixture.projections.size).toBe(1)
    expect(copied).toBe(0)
    const old = fixture.result.current[0].ignored
    ignored = false
    act(() => fixture.observer.invalidate('repo/.gitignore'))
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(copied).toBe(count)
    expect(fixture.publications.length - initialPublications).toBe(2)
    expect(fixture.projections.size).toBe(2)
    expect(old.get('wave00000')).toBe(true)
    expect(fixture.result.current[0].ignored.get('wave00000')).toBe(false)
    const unchanged = fixture.result.current[0].ignored
    act(() => fixture.observer.invalidate('repo/.gitignore'))
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(copied).toBe(count)
    expect(fixture.publications.length - initialPublications).toBe(2)
    expect(fixture.projections.size).toBe(2)
    expect(fixture.result.current[0].ignored).toBe(unchanged)
  }
)

it.each(['hide', 'input'] as const)(
  'retains settled prefix on %s before a pending suffix retires',
  async (interruption) => {
    vi.useFakeTimers()
    let reads = 0
    let finishOld!: () => void
    let start!: () => void
    let failFresh = false
    const fixture = mountProjection(4001, async (request) => {
      if (request.repositoryIntent === 'ignored') {
        reads++
        if (failFresh) {
          throw new Error('offline')
        }
        await (reads === 1
          ? new Promise<void>((resolve) => {
              start = resolve
            })
          : new Promise<void>((resolve) => {
              finishOld = resolve
            }))
        return [{ path: 'repo', kind: 'repository', ignoredPaths: request.repositoryQueryPaths! }]
      }
      return [
        { path: 'repo', kind: 'repository', status: { entries: [], conflictOperation: 'unknown' } }
      ]
    })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    const empty = fixture.result.current[0].ignored
    const before = fixture.publications.length
    await act(async () => {
      start()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(reads).toBe(2)
    expect(fixture.result.current[0].ignored).toBe(empty)
    failFresh = true
    if (interruption === 'hide') {
      fixture.rerender({ visible: false })
      expect(fixture.publications).toHaveLength(before)
      expect(fixture.result.current[0].ignored).toBe(empty)
      fixture.rerender({ visible: true })
    } else {
      act(() => fixture.observer.invalidate('repo/.gitignore'))
    }
    expect(fixture.publications).toHaveLength(before + 1)
    const prefix = fixture.result.current[0].ignored
    expect(prefix.size).toBe(2000)
    expect(prefix.get('wave00000')).toBe(true)
    await act(async () => {
      finishOld()
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(reads).toBeGreaterThan(2)
    expect(fixture.result.current[0].ignored).toBe(prefix)
    expect(prefix.has('wave02000')).toBe(false)
    expect(empty.size).toBe(0)
    expect(fixture.publications).toHaveLength(before + 1)
  }
)
