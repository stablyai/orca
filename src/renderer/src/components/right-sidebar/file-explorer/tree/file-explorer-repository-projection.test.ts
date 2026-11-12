import { ExplorerRepositoryPathIndex } from './file-explorer-repository-path-index'
import { afterEach, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import {
  FileExplorerRepositoryObserver,
  type ExplorerRepositorySource
} from './file-explorer-repository-observer'
import { ExplorerRepositoryDecorations } from './file-explorer-repository-decorations'

afterEach(() => vi.useRealTimers())

it.each([10, 100])(
  'bounds capped evidence across %i disjoint replies and isolates sibling/ignore projection',
  async (iterations) => {
    vi.useFakeTimers()
    let round = -1
    let complete = false
    let sources: readonly ExplorerRepositorySource[] = []
    const observer = new FileExplorerRepositoryObserver(
      async (request) => [
        {
          path: 'repo',
          kind: 'repository',
          ...(request.repositoryIntent === 'status'
            ? {
                status: {
                  entries: complete
                    ? []
                    : round === -1
                      ? [{ path: 'keep.txt', status: 'modified', area: 'unstaged' }]
                      : Array.from({ length: 1000 }, (_, index) => ({
                          path: `wave${round}/p${index}`,
                          status: 'untracked',
                          area: 'untracked'
                        })),
                  conflictOperation: 'unknown',
                  ...(complete || round === -1 ? {} : { didHitLimit: true })
                }
              }
            : { ignoredPaths: [] })
        }
      ],
      (next) => {
        sources = next
      }
    )
    observer.setFrontier([{ path: 'repo', marker: true }], ['repo'])
    observer.setDemand(['repo/keep.txt'])
    observer.setVisible(true)
    await vi.advanceTimersByTimeAsync(1000)
    const decorations = new ExplorerRepositoryDecorations()
    for (round = 0; round < iterations; round++) {
      observer.invalidate('repo/keep.txt')
      await vi.advanceTimersByTimeAsync(4000)
      expect(sources[0].entries.length).toBeLessThanOrEqual(1001)
      expect(sources[0].summaries.size).toBeLessThanOrEqual(2)
      expect(decorations.update([], sources).statusByRelativePath.get('repo/keep.txt')).toBe(
        'modified'
      )
    }
    observer.invalidateChanges([{ path: 'repo/keep.txt', kind: 'delete' }])
    expect(
      decorations.update([], sources).statusByRelativePath.get('repo/keep.txt')
    ).toBeUndefined()
    observer.setDemand([])
    expect(sources[0].entries).toHaveLength(1000)
    expect(decorations.update([], sources).folderStatusByRelativePath.get('repo')).toBe('modified')
    complete = true
    observer.invalidate('repo/keep.txt')
    await vi.advanceTimersByTimeAsync(4000)
    expect(sources[0].entries).toEqual([])
    expect(decorations.update([], sources).folderStatusByRelativePath.get('repo')).toBeUndefined()
    observer.dispose()

    let unrelatedReads = 0
    const stableRoot: GitStatusEntry[] = []
    const siblings: ExplorerRepositorySource[] = Array.from({ length: iterations }, (_, index) => ({
      path: `r${index}`,
      ignored: new Map(),
      summaries: new Map(),
      entries: [
        {
          get path() {
            unrelatedReads++
            return `file${index}.txt`
          },
          status: 'modified',
          area: 'unstaged'
        }
      ]
    }))
    const first = decorations.update(stableRoot, siblings)
    unrelatedReads = 0
    const second = decorations.update(
      stableRoot,
      siblings.map((source, index) =>
        index === 0
          ? { ...source, entries: [{ path: 'file.txt', status: 'added', area: 'unstaged' }] }
          : source
      )
    )
    expect(unrelatedReads).toBe(0)
    expect(second.folderStatusByRelativePath.get('r0')).toBe('added')
    expect(first.folderStatusByRelativePath.get('r0')).toBe('modified')
    const changed = siblings.map((source, index) =>
      index === 0
        ? {
            ...source,
            entries: [
              { path: 'file.txt', status: 'added', area: 'unstaged' }
            ] satisfies GitStatusEntry[]
          }
        : source
    )
    const beforeIgnore = decorations.update(stableRoot, changed)
    const afterIgnore = decorations.update(
      stableRoot,
      changed.map((source) => ({ ...source, ignored: new Map([['file.txt', true]]) }))
    )
    expect(afterIgnore).toBe(beforeIgnore)
    expect(unrelatedReads).toBe(0)
  }
)

it.each([100, 1000])(
  'visits each indexed descendant once across interleaved event ranges at %i paths',
  (count) => {
    const paths = Array.from({ length: count }, (_, index) => `aa/sub/deep/p${index}`)
    const indexed = new Set(paths)
    const index = new ExplorerRepositoryPathIndex()
    index.set(paths)
    index.descendants([])
    let visits = 0
    const original = Set.prototype.add
    const spy = vi.spyOn(Set.prototype, 'add').mockImplementation(function (
      this: Set<string>,
      value
    ) {
      if (indexed.has(value)) {
        visits++
      }
      return original.call(this, value)
    })
    let answer = new Set<string>()
    try {
      answer = index.descendants(['aa', 'aa-aux', 'aa/sub', 'aa/sub-aux', 'aa/sub/deep'])
    } finally {
      spy.mockRestore()
    }
    expect(answer).toEqual(indexed)
    expect(visits).toBe(count)
    const lookup = new ExplorerRepositoryDecorations().update(
      [{ path: 'a/b/c/d/e/file.txt', status: 'modified', area: 'unstaged' }],
      []
    ).statusByRelativePath
    let ownershipChecks = 0
    const has = Set.prototype.has
    const membership = vi.spyOn(Set.prototype, 'has').mockImplementation(function (
      this: Set<string>,
      value
    ) {
      ownershipChecks++
      return has.call(this, value)
    })
    const statuses = Array.from({ length: count }, () => lookup.get('a/b/c/d/e/file.txt'))
    membership.mockRestore()
    expect(statuses.every((status) => status === 'modified')).toBe(true)
    expect(ownershipChecks).toBe(0)
  }
)

it.each([1, 10])(
  'does not revisit complete status payloads on demand changes across %i sources',
  async (count) => {
    vi.useFakeTimers()
    let reads = 0
    let sources: readonly ExplorerRepositorySource[] = []
    const observer = new FileExplorerRepositoryObserver(
      async (request) => [
        {
          path: request.repositoryPaths![0],
          kind: 'repository',
          ...(request.repositoryIntent === 'status'
            ? {
                status: {
                  entries: Array.from({ length: 1000 }, (_, index) => ({
                    get path() {
                      reads++
                      return `file${index}.txt`
                    },
                    status: 'modified',
                    area: 'unstaged'
                  })),
                  conflictOperation: 'unknown'
                }
              }
            : { ignoredPaths: [] })
        }
      ],
      (next) => {
        sources = next
      }
    )
    const candidates = Array.from({ length: count }, (_, index) => ({
      path: `r${index}`,
      marker: true
    }))
    observer.setFrontier(
      candidates,
      candidates.map((candidate) => candidate.path)
    )
    observer.setVisible(true)
    await vi.advanceTimersByTimeAsync(1000)
    const entries = sources.map((source) => source.entries)
    reads = 0
    for (let wave = 0; wave < 10; wave++) {
      observer.setDemand(candidates.map((candidate) => `${candidate.path}/p${wave}`))
    }
    expect(reads).toBe(0)
    expect(sources.every((source, index) => source.entries === entries[index])).toBe(true)
    observer.dispose()
  }
)
