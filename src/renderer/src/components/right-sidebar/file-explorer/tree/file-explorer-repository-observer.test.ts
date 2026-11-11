import { afterEach, expect, it, vi } from 'vitest'
import type {
  GitRepositoryStatusRequest,
  GitRepositoryStatus
} from '../../../../../../shared/git/status/git-repository-status'
import {
  FileExplorerRepositoryObserver,
  type ExplorerRepositorySource
} from './file-explorer-repository-observer'
import { buildExplorerRepositoryDecorations } from './file-explorer-repository-decorations'
import {
  buildIgnoredSet,
  isPathIgnored,
  type RepositoryIgnoredPathSet
} from '../../../../lib/source-control/paths/git-path-decoration'

afterEach(() => vi.useRealTimers())

it.each([100, 1000])(
  'bounds cold/safety work by %i frontier directories and their owning repositories',
  async (count) => {
    vi.useFakeTimers()
    const requests: GitRepositoryStatusRequest[] = []
    let active = 0
    let maximumActive = 0
    let releaseSlow: (() => void) | undefined
    let sources: readonly ExplorerRepositorySource[] = []
    let updates = 0
    const read = async (
      request: GitRepositoryStatusRequest,
      signal: AbortSignal
    ): Promise<GitRepositoryStatus[]> => {
      requests.push(request)
      if (request.repositoryIntent === 'probe') {
        return request.repositoryPaths!.map((path) => ({
          path,
          kind: Number(path.slice(1)) % 10 === 0 ? 'repository' : 'absent'
        }))
      }
      active++
      maximumActive = Math.max(maximumActive, active)
      try {
        if (
          request.repositoryPaths![0] === 'd0' &&
          request.repositoryIntent === 'status' &&
          !releaseSlow
        ) {
          await new Promise<void>((resolve, reject) => {
            releaseSlow = resolve
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }
        if (request.repositoryPaths![0] !== 'd0' || request.repositoryIntent !== 'status') {
          await new Promise<void>((resolve) => {
            // ast-grep-ignore: test-no-real-time-wait -- Fake time models an in-flight Git read; no wall-clock wait.
            setTimeout(resolve, 1)
          })
        }
        return [
          {
            path: request.repositoryPaths![0],
            kind: 'repository',
            ...(request.repositoryIntent === 'status'
              ? { status: { entries: [], conflictOperation: 'unknown' } }
              : { ignoredPaths: [] })
          }
        ]
      } finally {
        active--
      }
    }
    const observer = new FileExplorerRepositoryObserver(read, (next) => {
      sources = next
      updates++
    })
    const candidates = Array.from({ length: count }, (_, i) => ({ path: `d${i}` }))
    observer.setFrontier(
      candidates,
      candidates.map((candidate) => candidate.path)
    )
    observer.setDemand(['d10/file.txt'])
    observer.setVisible(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests.filter((request) => request.repositoryIntent === 'probe')).toHaveLength(
      count / 100
    )
    expect(requests.filter((request) => request.repositoryIntent === 'status')).toHaveLength(
      count / 10
    )
    expect(requests.filter((request) => request.repositoryIntent === 'ignored')).toHaveLength(1)
    expect(sources).toHaveLength(count / 10)
    expect(maximumActive).toBeLessThanOrEqual(4)
    expect(active).toBe(1)
    releaseSlow!()
    await vi.advanceTimersByTimeAsync(4000)
    requests.length = 0
    updates = 0
    observer.invalidate('d10/file.txt')
    await vi.advanceTimersByTimeAsync(4000)
    expect(requests.map((request) => [request.repositoryIntent, request.repositoryPaths])).toEqual([
      ['status', ['d10']]
    ])
    expect(updates).toBe(0)
    requests.length = 0
    observer.invalidate('ordinary.txt')
    await vi.advanceTimersByTimeAsync(4000)
    expect(requests).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requests.filter((request) => request.repositoryIntent === 'status')).toHaveLength(
      count / 10
    )
    expect(
      requests
        .filter((request) => request.repositoryIntent === 'probe')
        .flatMap((request) => request.repositoryPaths!)
    ).toHaveLength(0)
    expect(requests.filter((request) => request.repositoryIntent === 'ignored')).toHaveLength(1)
    observer.setVisible(false)
    requests.length = 0
    observer.invalidate()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(requests).toEqual([])
    observer.dispose()
  }
)

it('retains owning boundaries and collapsed ancestor badges, segments exact ignore answers and rejects obsolete output', async () => {
  vi.useFakeTimers()
  let sources: readonly ExplorerRepositorySource[] = []
  let ignored = true
  let failLast = false
  let statusMode: 'changed' | 'clean' | 'error' | 'partial' = 'changed'
  const ignoreRequests: string[][] = []
  const observer = new FileExplorerRepositoryObserver(
    async (request) => {
      const path = request.repositoryPaths![0]
      if (request.repositoryIntent === 'probe') {
        return [{ path, kind: 'repository' }]
      }
      if (request.repositoryIntent === 'ignored') {
        const query = request.repositoryQueryPaths!
        ignoreRequests.push(query)
        if (failLast && query.includes('p2000')) {
          throw new Error('unavailable')
        }
        return [
          {
            path,
            kind: 'repository',
            ignoredPaths: ignored ? query.filter((item) => item !== 'folder/tracked.txt') : []
          }
        ]
      }
      return [
        {
          path,
          kind: 'repository',
          status: {
            conflictOperation: 'unknown',
            entries:
              statusMode === 'clean' || statusMode === 'error'
                ? []
                : [
                    {
                      path: statusMode === 'partial' ? 'new.txt' : 'folder/file.txt',
                      status: 'modified',
                      area: 'unstaged'
                    }
                  ],
            ...(statusMode === 'error' ? { readError: 'unavailable' } : {}),
            ...(statusMode === 'partial' ? { didHitLimit: true } : {})
          }
        }
      ]
    },
    (next) => {
      sources = next
    }
  )
  observer.setFrontier([{ path: 'group/repo', marker: true }], ['group/repo'])
  observer.setDemand([
    'group/repo/folder',
    'group/repo/folder/file.txt',
    'group/repo/folder/tracked.txt'
  ])
  observer.setVisible(true)
  await vi.advanceTimersByTimeAsync(1000)
  const paths: RepositoryIgnoredPathSet = buildIgnoredSet(['group'])
  paths.repositories = new Map(sources.map((source) => [source.path, source.ignored]))
  expect(isPathIgnored(paths, 'group/repo/folder/file.txt')).toBe(true)
  expect(isPathIgnored(paths, 'group/repo/folder/tracked.txt')).toBe(false)
  expect(isPathIgnored(paths, 'group/repo/clean.txt')).toBe(false)
  expect(isPathIgnored(paths, 'group/repo')).toBe(true)
  observer.setFrontier([{ path: 'group', marker: false }], ['group'])
  expect(sources).toHaveLength(1)
  expect(
    buildExplorerRepositoryDecorations([], sources).folderStatusByRelativePath.get('group')
  ).toBe('modified')
  statusMode = 'error'
  observer.invalidate('group/repo/folder/file.txt')
  await vi.advanceTimersByTimeAsync(4000)
  expect(sources[0].entries[0].path).toBe('folder/file.txt')
  statusMode = 'partial'
  observer.invalidate('group/repo/new.txt')
  await vi.advanceTimersByTimeAsync(4000)
  expect(sources[0].entries.map((entry) => entry.path)).toEqual(['new.txt', 'folder/file.txt'])
  statusMode = 'clean'
  observer.invalidate('group/repo/new.txt')
  await vi.advanceTimersByTimeAsync(4000)
  const decoration = buildExplorerRepositoryDecorations(
    [
      { path: 'group/repo/', area: 'untracked', status: 'untracked' },
      { path: 'group/repo/wrong.txt', area: 'unstaged', status: 'modified' }
    ],
    sources
  )
  expect(decoration.folderStatusByRelativePath.get('group/repo')).toBe('untracked')
  expect(decoration.statusByRelativePath.has('group/repo/wrong.txt')).toBe(false)
  expect(sources[0].entries).toEqual([])
  observer.setDemand(
    Array.from({ length: 4001 }, (_, index) => `group/repo/p${String(index).padStart(4, '0')}`)
  )
  ignoreRequests.length = 0
  await vi.advanceTimersByTimeAsync(4000)
  expect(ignoreRequests.map((query) => query.length)).toEqual([2000, 2000, 1])
  expect(sources[0].ignored.get('p2000')).toBe(true)
  ignored = false
  failLast = true
  observer.invalidate('group/repo/.gitignore')
  await vi.advanceTimersByTimeAsync(4000)
  expect(sources[0].ignored.get('p0000')).toBe(false)
  expect(sources[0].ignored.get('p2000')).toBe(true)
  expect(sources[0].ignored.get('p4000')).toBe(false)
  failLast = false
  // No file event: the existing source safety opportunity heals missed exclude/index changes.
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sources[0].ignored.get('p2000')).toBe(false)
  observer.setFrontier([{ path: 'other', marker: false }], ['other'])
  expect(sources).toEqual([])
  observer.dispose()

  let finish: ((records: GitRepositoryStatus[]) => void) | undefined
  const publish = vi.fn()
  const obsolete = new FileExplorerRepositoryObserver(
    async () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    publish
  )
  obsolete.setFrontier([{ path: 'old' }], ['old'])
  obsolete.setVisible(true)
  await vi.advanceTimersByTimeAsync(1)
  obsolete.dispose()
  finish!([{ path: 'old', kind: 'repository' }])
  await vi.advanceTimersByTimeAsync(1000)
  expect(publish).not.toHaveBeenCalled()
})
