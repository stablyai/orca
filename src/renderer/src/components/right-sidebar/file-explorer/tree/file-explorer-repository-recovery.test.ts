import { ExplorerRepositoryFrontier } from './file-explorer-repository-frontier-owner'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  GitRepositoryStatus,
  GitRepositoryStatusRequest
} from '../../../../../../shared/git/status/git-repository-status'
import {
  FileExplorerRepositoryObserver,
  type ExplorerRepositorySource
} from './file-explorer-repository-observer'
import { buildExplorerRepositoryFrontier } from './file-explorer-repository-frontier'
import { createVisibleFileExplorerRowProjection } from './useFileExplorerVisibleRowProjection'
import type { DirCache } from './file-explorer-types'
import {
  buildIgnoredSet,
  type RepositoryIgnoredPathSet
} from '../../../../lib/source-control/paths/git-path-decoration'

afterEach(() => vi.useRealTimers())

it('keeps uncertain listing boundaries, heals under activity, and catches up reveal without re-probing fresh negatives', async () => {
  vi.useFakeTimers()
  const requests: GitRepositoryStatusRequest[] = []
  let sources: readonly ExplorerRepositorySource[] = []
  let initialized = false
  let ignored = true
  const observer = new FileExplorerRepositoryObserver(
    async (request) => {
      requests.push(request)
      if (request.repositoryIntent === 'probe') {
        return request.repositoryPaths!.map((path) => ({
          path,
          kind: path === 'child' || initialized ? 'repository' : 'absent'
        }))
      }
      return [
        {
          path: request.repositoryPaths![0],
          kind: 'repository',
          ...(request.repositoryIntent === 'status'
            ? {
                status: {
                  entries: [{ path: 'forced.tmp', status: 'modified', area: 'unstaged' }],
                  conflictOperation: 'unknown'
                }
              }
            : {
                ignoredPaths: ignored
                  ? request.repositoryQueryPaths!.filter((path) => path !== 'forced.tmp')
                  : []
              })
        }
      ]
    },
    (next) => {
      sources = next
    }
  )
  const owner = { kind: 'local' } as const
  const row = (name: string, directory: boolean) => ({
    name,
    path: `/w/${name}`,
    relativePath: name,
    isDirectory: directory,
    depth: 0,
    operationOwner: owner
  })
  const root: DirCache = {
    operationOwner: owner,
    children: [row('child', true), row('later', true)]
  }
  const apply = (cache: Record<string, DirCache>) => {
    const frontier = buildExplorerRepositoryFrontier('/w', '/w', cache, new Set(), owner, true)
    observer.setFrontier(frontier.candidates, frontier.dependencies, frontier.retainedSubtrees)
  }
  apply({ '/w': root })
  observer.setDemand(['child/hidden.tmp', 'child/forced.tmp'])
  observer.setVisible(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(sources.map((source) => source.path)).toEqual(['child'])
  const uncertainCaches: Record<string, DirCache>[] = [
    {},
    { '/w': { ...root, children: [], error: 'offline' } },
    { '/w': { ...root, children: [], more: { after: { name: 'a', isDirectory: false } } } }
  ]
  for (const cache of uncertainCaches) {
    apply(cache)
    expect(sources.map((source) => source.path)).toEqual(['child'])
  }
  apply({ '/w': root })
  const projection = (nameFilter: boolean) => {
    const own: RepositoryIgnoredPathSet = buildIgnoredSet(['child'])
    own.repositories = new Map(sources.map((source) => [source.path, source.ignored]))
    return createVisibleFileExplorerRowProjection(
      {
        worktreePath: '/w',
        displayRootPath: '/w/child',
        expanded: new Set(),
        dirCache: {
          '/w/child': {
            children: ['hidden.tmp', 'forced.tmp'].map((name) => ({
              ...row(`child/${name}`, false),
              name
            }))
          }
        }
      },
      {
        ignoredSet: own,
        showDotfiles: true,
        showGitIgnoredFiles: false,
        ...(nameFilter
          ? {
              nameFilter: { query: '.tmp', relativePaths: ['child/hidden.tmp', 'child/forced.tmp'] }
            }
          : {})
      }
    )
  }
  expect(projection(false).hasPath('/w/child/hidden.tmp')).toBe(false)
  expect(projection(false).hasPath('/w/child/forced.tmp')).toBe(true)
  expect(projection(true).hasPath('/w/child/forced.tmp')).toBe(true)
  initialized = true
  observer.invalidateChanges([{ path: 'later/.git', kind: 'create' }])
  ignored = false
  requests.length = 0
  for (let index = 0; index < 14; index++) {
    observer.invalidate('child/ordinary.txt')
    apply({ '/w': { ...root } })
    await vi.advanceTimersByTimeAsync(10_000)
  }
  expect(sources.map((source) => source.path)).toEqual(['child', 'later'])
  expect(sources.find((source) => source.path === 'child')!.ignored.get('hidden.tmp')).toBe(false)
  expect(projection(false).hasPath('/w/child/hidden.tmp')).toBe(true)
  expect(projection(true).hasPath('/w/child/hidden.tmp')).toBe(true)
  expect(
    requests.filter((request) => request.repositoryIntent === 'probe').length
  ).toBeLessThanOrEqual(2)
  observer.setVisible(false)
  requests.length = 0
  observer.invalidateChanges([
    { path: 'child/new', directory: true, kind: 'create' },
    { path: 'child/new/sub', directory: true, kind: 'create' }
  ])
  await vi.advanceTimersByTimeAsync(1000)
  expect(requests).toEqual([])
  observer.setVisible(true)
  await vi.advanceTimersByTimeAsync(4000)
  expect(requests.some((request) => request.repositoryIntent === 'ignored')).toBe(true)
  expect(requests.filter((request) => request.repositoryIntent === 'probe')).toEqual([])
  apply({ '/w': { ...root, children: [] } })
  expect(sources).toEqual([])
  observer.dispose()
})

it.each([2000, 20000])(
  'queries only new ignore demand among %i established answers and backs off unknown discovery',
  async (count) => {
    vi.useFakeTimers()
    const requests: GitRepositoryStatusRequest[] = []
    const observer = new FileExplorerRepositoryObserver(
      async (request) => {
        requests.push(request)
        if (request.repositoryIntent === 'probe') {
          return request.repositoryPaths!.map((path) => ({ path, kind: 'unknown' }))
        }
        return [
          {
            path: 'repo',
            kind: 'repository',
            ...(request.repositoryIntent === 'status'
              ? { status: { entries: [], conflictOperation: 'unknown' } }
              : { ignoredPaths: [] })
          }
        ]
      },
      () => {}
    )
    const candidates = [{ path: 'repo', marker: true }, { path: 'unreadable' }]
    observer.setFrontier(candidates, ['repo', 'unreadable'])
    const paths = Array.from({ length: count }, (_, index) => `repo/p${index}`)
    observer.setDemand(paths)
    observer.setVisible(true)
    await vi.advanceTimersByTimeAsync(1000)
    requests.length = 0
    observer.setDemand([...paths, 'repo/new.txt'])
    await vi.advanceTimersByTimeAsync(4000)
    expect(
      requests
        .filter((request) => request.repositoryIntent === 'ignored')
        .map((request) => request.repositoryQueryPaths)
    ).toEqual([['new.txt']])
    requests.length = 0
    for (let index = 0; index < 120; index++) {
      observer.setFrontier(candidates, ['repo', 'unreadable'])
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(requests.filter((request) => request.repositoryIntent === 'probe')).toHaveLength(2)
    observer.dispose()
  }
)

it('heals each input from its own validation and backs off failed attempts without freshening status', async () => {
  vi.useFakeTimers()
  const requests: { intent: string | undefined; at: number }[] = []
  let failStatus = false
  const observer = new FileExplorerRepositoryObserver(
    async (request) => {
      requests.push({ intent: request.repositoryIntent, at: Date.now() })
      if (request.repositoryIntent === 'status' && failStatus) {
        throw new Error('offline')
      }
      return [
        {
          path: 'repo',
          kind: 'repository',
          ...(request.repositoryIntent === 'status'
            ? { status: { entries: [], conflictOperation: 'unknown' } }
            : { ignoredPaths: [] })
        }
      ]
    },
    () => {}
  )
  observer.setFrontier([{ path: 'repo', marker: true }], ['repo'])
  observer.setDemand(['repo/file'])
  observer.setVisible(true)
  await vi.advanceTimersByTimeAsync(40_000)
  observer.invalidate('repo/file')
  await vi.advanceTimersByTimeAsync(1000)
  requests.length = 0
  await vi.advanceTimersByTimeAsync(20_000)
  expect(requests.map((request) => request.intent)).toEqual(['ignored'])
  requests.length = 0
  await vi.advanceTimersByTimeAsync(41_000)
  expect(requests.map((request) => request.intent)).toEqual(['status'])
  requests.length = 0
  failStatus = true
  observer.invalidate('repo/file')
  await vi.advanceTimersByTimeAsync(4000)
  const failedAt = requests.find((request) => request.intent === 'status')!.at
  requests.length = 0
  for (let index = 0; index < 20; index++) {
    observer.setDemand(['repo/file', `repo/new${index}`])
    await vi.advanceTimersByTimeAsync(1000)
  }
  expect(requests.some((request) => request.intent === 'status')).toBe(false)
  failStatus = false
  await vi.advanceTimersByTimeAsync(60_000)
  const retry = requests.find((request) => request.intent === 'status')!
  expect(retry.at - failedAt).toBeGreaterThanOrEqual(60_000)
  expect(retry.at - failedAt).toBeLessThanOrEqual(63_000)
  observer.dispose()
})

function discoveryCache(count: number): Record<string, DirCache> {
  const operationOwner = { kind: 'local' } as const
  return {
    '/w': {
      operationOwner,
      children: Array.from({ length: count }, (_, index) => ({
        name: `d${index}`,
        path: `/w/d${index}`,
        relativePath: `d${index}`,
        isDirectory: true,
        depth: 0,
        operationOwner
      }))
    },
    '/w/d0': { operationOwner, children: [] }
  }
}

function applyDiscoveryCache(
  observer: FileExplorerRepositoryObserver,
  cache: Record<string, DirCache>
): void {
  const frontier = buildExplorerRepositoryFrontier(
    '/w',
    '/w',
    cache,
    new Set(),
    { kind: 'local' },
    true
  )
  observer.setFrontier(frontier.candidates, frontier.dependencies, frontier.retainedSubtrees)
}

it('discards invalidated in-flight discovery proof while healthy siblings and later batches progress', async () => {
  vi.useFakeTimers()
  const probes: string[][] = []
  let release!: (results: GitRepositoryStatus[]) => void
  let sources: readonly ExplorerRepositorySource[] = []
  const observer = new FileExplorerRepositoryObserver(
    async (request) => {
      if (request.repositoryIntent === 'probe') {
        const paths = request.repositoryPaths!
        probes.push(paths)
        if (probes.length === 1) {
          return await new Promise<GitRepositoryStatus[]>((resolve) => {
            release = resolve
          })
        }
        return paths.map((path) => ({ path, kind: 'repository' }))
      }
      return [
        {
          path: request.repositoryPaths![0],
          kind: 'repository',
          status: { entries: [], conflictOperation: 'unknown' }
        }
      ]
    },
    (next) => {
      sources = next
    }
  )
  const cache = discoveryCache(101)
  const frontier = new ExplorerRepositoryFrontier(
    '/w',
    { kind: 'local' },
    {
      apply: (changes, affected, retains) => observer.updateFrontier(changes, affected, retains),
      invalidate: (path) => observer.invalidateCandidate(path),
      resetProof: () => observer.invalidate(),
      branches: (path) => observer.proofBranches(path),
      invalidateSubtree: (path) => observer.invalidateProofSubtree(path)
    }
  )
  frontier.setView('/w', new Set(), true)
  frontier.commit(cache, [], true)
  frontier.setVisible(true)
  observer.setVisible(true)
  try {
    await vi.advanceTimersByTimeAsync(1000)
    expect(probes).toHaveLength(1)
    expect(probes[0]).toHaveLength(100)
    frontier.commit(
      {
        ...cache,
        '/w': {
          ...cache['/w'],
          children: cache['/w'].children.filter((child) => child.relativePath !== 'd1')
        }
      },
      ['/w']
    )
    frontier.commit(cache, ['/w'])
    release(probes[0].map((path) => ({ path, kind: 'repository' })))
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(2)
    expect(probes[1]).toEqual(['d100'])
    expect(sources).toHaveLength(100)
    expect(sources.some((source) => source.path === 'd0')).toBe(true)
    expect(sources.some((source) => source.path === 'd100')).toBe(true)
    expect(sources.some((source) => source.path === 'd1')).toBe(false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(probes).toHaveLength(3)
    expect(probes[2]).toEqual(['d1'])
    expect(sources).toHaveLength(101)
    expect(sources.some((source) => source.path === 'd1')).toBe(true)
  } finally {
    observer.dispose()
  }
})

it.each(['resolve', 'reject'] as const)(
  'retries canceled discovery after frontier rewrapping and %s settlement before reveal',
  async (settlement) => {
    vi.useFakeTimers()
    let sources: readonly ExplorerRepositorySource[] = []
    const probes: string[][] = []
    let resolveOld!: (results: GitRepositoryStatus[]) => void
    let rejectOld!: (error: Error) => void
    const observer = new FileExplorerRepositoryObserver(
      async (request) => {
        if (request.repositoryIntent === 'probe') {
          probes.push(request.repositoryPaths!)
          if (probes.length === 1) {
            return await new Promise<GitRepositoryStatus[]>((resolve, reject) => {
              resolveOld = resolve
              rejectOld = reject
            })
          }
          return request.repositoryPaths!.map((path) => ({ path, kind: 'repository' }))
        }
        return [
          {
            path: request.repositoryPaths![0],
            kind: 'repository',
            status: { entries: [], conflictOperation: 'unknown' }
          }
        ]
      },
      (next) => {
        sources = next
      }
    )
    const cache = discoveryCache(1)
    applyDiscoveryCache(observer, cache)
    observer.setVisible(true)
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(probes).toEqual([['d0']])
      applyDiscoveryCache(observer, { ...cache })
      observer.setVisible(false)
      if (settlement === 'resolve') {
        resolveOld([{ path: 'd0', kind: 'repository' }])
      } else {
        rejectOld(new Error('canceled'))
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(sources).toHaveLength(0)
      applyDiscoveryCache(observer, discoveryCache(0))
      applyDiscoveryCache(observer, cache)
      observer.setVisible(true)
      await vi.advanceTimersByTimeAsync(4000)
      expect(probes).toEqual([['d0'], ['d0']])
      expect(sources.map((source) => source.path)).toEqual(['d0'])
    } finally {
      observer.dispose()
    }
  }
)
