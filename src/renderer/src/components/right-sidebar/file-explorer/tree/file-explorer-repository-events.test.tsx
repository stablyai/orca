// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFileExplorerRepositories } from './use-file-explorer-repositories'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import type { FsChangeEvent } from '../../../../../../shared/file-watch/filesystem-change-event'
import type { GitRepositoryStatusRequest } from '../../../../../../shared/git/status/git-repository-status'
import type { UseFileExplorerTreeResult } from './file-explorer-types'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', () => ({
  getRuntimeGitStatus: read,
  supportsRuntimeGitRepositories: async () => true
}))
vi.mock('../navigation/file-explorer-operation-owner', () => ({
  useFileListOperationOwner: () => ({
    kind: 'runtime',
    environmentId: 'test-host',
    executionHostId: 'runtime:test-host'
  }),
  getFileExplorerOperationRoute: () => ({
    target: { kind: 'environment', environmentId: 'test-host' }
  })
}))
vi.mock('@/runtime/hosts/connections/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: () => () => {}
}))
vi.mock('@/lib/window-activity/window-visibility-interval', () => ({ isWindowVisible: () => true }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  read.mockReset()
})

const owner = {
  kind: 'runtime',
  environmentId: 'test-host',
  executionHostId: 'runtime:test-host'
} as const
const expanded = new Set<string>()
const tree: Pick<UseFileExplorerTreeResult, 'sourceWorkspaceId' | 'dirCache'> = {
  sourceWorkspaceId: 'folder:w',
  dirCache: {
    '/w': { repositoryMarker: false, operationOwner: owner, children: [] },
    '/w/group/repo': { repositoryMarker: true, operationOwner: owner, children: [] }
  }
}

function mountRepository() {
  return renderHook(() =>
    useFileExplorerRepositories('folder:w', '/w', '/w/group/repo', tree, expanded, true, false)
  )
}
function send(
  kind: FsChangeEvent['kind'],
  path: string,
  isDirectory?: boolean,
  oldAbsolutePath?: string
) {
  window.dispatchEvent(
    new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
      detail: {
        runtimeEnvironmentId: 'test-host',
        payload: {
          worktreePath: '/w',
          events: [{ kind, absolutePath: path, isDirectory, oldAbsolutePath }]
        }
      }
    })
  )
}
const status = { entries: [], conflictOperation: 'unknown' }

it.each([1, 10])(
  'keeps %i ignore chunks and failed-path backoff across directory-update churn',
  async (chunks) => {
    vi.useFakeTimers()
    const sends: string[][] = []
    let statuses = 0
    let aborted = 0
    read.mockImplementation(
      async (_route, request: GitRepositoryStatusRequest & { signal: AbortSignal }) => {
        if (request.repositoryIntent === 'ignored') {
          const paths = request.repositoryQueryPaths!
          sends.push(paths)
          request.signal.addEventListener(
            'abort',
            () => {
              aborted++
            },
            { once: true }
          )
          await new Promise<void>((resolve) => {
            // ast-grep-ignore: test-no-real-time-wait-tsx -- Fake time models an in-flight Git read; no wall-clock wait.
            setTimeout(resolve, 500)
          })
          return {
            repositoryStatuses: [
              {
                path: 'group/repo',
                kind: paths.includes('p00000') ? 'unknown' : 'repository',
                ignoredPaths: []
              }
            ]
          }
        }
        statuses++
        return { repositoryStatuses: [{ path: 'group/repo', kind: 'repository', status }] }
      }
    )
    const fixture = mountRepository()
    act(() =>
      fixture.result.current.setDemand(
        Array.from(
          { length: chunks * 2000 },
          (_, index) => `group/repo/p${String(index).padStart(5, '0')}`
        )
      )
    )
    await act(() => vi.advanceTimersByTimeAsync(1000))
    for (let index = 0; index < 20; index++) {
      act(() => send('update', index % 2 ? '/w/group' : '/w/group/repo', true))
      await act(() => vi.advanceTimersByTimeAsync(1000))
    }
    expect(sends).toHaveLength(chunks)
    expect(aborted).toBe(0)
    expect(statuses).toBeGreaterThan(1)
    expect(fixture.result.current.sources[0].ignored.size).toBe((chunks - 1) * 2000)
    await act(() => vi.advanceTimersByTimeAsync(45_000))
    expect(sends.filter((paths) => paths.includes('p00000'))).toHaveLength(2)
  }
)

it('distinguishes ordinary updates from root identity and metadata changes through the hook', async () => {
  vi.useFakeTimers()
  let statuses = 0
  let ignores = 0
  let recovered = false
  read.mockImplementation(async (_route, request: GitRepositoryStatusRequest) => {
    if (request.repositoryIntent === 'ignored') {
      ignores++
      return {
        repositoryStatuses: [{ path: 'group/repo', kind: 'repository', ignoredPaths: ['keep'] }]
      }
    }
    statuses++
    return {
      repositoryStatuses: [
        {
          path: 'group/repo',
          kind: recovered ? 'repository' : 'unknown',
          ...(recovered ? { status } : {})
        }
      ]
    }
  })
  const fixture = mountRepository()
  act(() => fixture.result.current.setDemand(['group/repo/keep']))
  await act(() => vi.advanceTimersByTimeAsync(1000))
  for (let index = 0; index < 10; index++) {
    act(() => {
      send('update', '/w/group/repo', true)
      send('update', '/w/group', true)
      send('update', '/w', true)
      send('create', '/w/group/repo/new')
    })
    await act(() => vi.advanceTimersByTimeAsync(1000))
  }
  expect(statuses).toBe(1)
  expect(ignores).toBe(1)
  expect(fixture.result.current.sources[0].ignored.get('keep')).toBe(true)
  act(() => send('update', '/w/group/repo/.gitignore'))
  await act(() => vi.advanceTimersByTimeAsync(4000))
  expect(statuses).toBe(1)
  expect(ignores).toBe(2)
  for (const [kind, path, old] of [
    ['create', '/w/group/repo'],
    ['rename', '/w/group', '/outside/old'],
    ['delete', '/w/group/repo'],
    ['rename', '/outside/new', '/w/group'],
    ['update', '/w/group/repo/.git']
  ] as const) {
    const before = statuses
    act(() => send(kind, path, undefined, old))
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(statuses).toBe(before + 1)
  }
  recovered = true
  act(() => send('update', '/w/group/repo/.git'))
  await act(() => vi.advanceTimersByTimeAsync(4000))
  expect(statuses).toBe(7)
})

it.each(['update', 'proof'] as const)(
  'fences a pending unknown only for a newer %s input',
  async (input) => {
    vi.useFakeTimers()
    let statuses = 0
    let release!: () => void
    read.mockImplementation(async (_route, request: GitRepositoryStatusRequest) => {
      if (request.repositoryIntent === 'ignored') {
        return {
          repositoryStatuses: [{ path: 'group/repo', kind: 'repository', ignoredPaths: [] }]
        }
      }
      statuses++
      if (statuses === 1) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { repositoryStatuses: [{ path: 'group/repo', kind: 'unknown' }] }
      }
      return { repositoryStatuses: [{ path: 'group/repo', kind: 'repository', status }] }
    })
    mountRepository()
    await act(() => vi.advanceTimersByTimeAsync(1000))
    act(() => send('update', input === 'proof' ? '/w/group/repo/.git' : '/w/group/repo', true))
    await act(async () => {
      release()
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(statuses).toBe(input === 'proof' ? 2 : 1)
  }
)
