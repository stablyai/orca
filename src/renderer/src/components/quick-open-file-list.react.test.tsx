// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../../shared/quick-open-listing-limits'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RuntimeFileListState } from './quick-open-file-list'
import { QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS } from './quick-open-search'
import {
  listRuntimeFilesMock,
  cancelRuntimeFileListMock,
  searchRuntimeFilePathsMock,
  initialAppState,
  makeProjectGroup,
  makeFolderWorkspace,
  seedRemoteWorktree,
  HookProbe,
  flushEffects,
  waitForListRuntimeFilesCall,
  renderProbe
} from './quick-open-file-list-test-harness'

vi.mock('@/runtime/runtime-file-client', async () => {
  const mocks = await import('./__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})

describe('useRuntimeFileListForWorktree', () => {
  it('settles a Windows folder listing failure and recovers after reopening', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ folderPath: 'C:\\fixture', connectionId: null })],
      projectGroups: [makeProjectGroup({ parentPath: 'C:\\fixture', connectionId: null })],
      repos: [],
      worktreesByRepo: {}
    })
    listRuntimeFilesMock.mockRejectedValueOnce(new Error('fixture launcher failed'))
    const states: RuntimeFileListState[] = []
    const args = {
      enabled: true,
      worktreeId: workspaceKey,
      states
    }
    const root = await renderProbe(args)
    await waitForListRuntimeFilesCall()
    await flushEffects()
    expect(states.at(-1)?.loading).toBe(false)
    expect(states.at(-1)?.loadError).toBe('fixture launcher failed')
    await act(async () => {
      root.render(createElement(HookProbe, { ...args, enabled: false }))
    })
    listRuntimeFilesMock.mockResolvedValueOnce(['example.txt'])
    await act(async () => {
      root.render(createElement(HookProbe, args))
    })
    await flushEffects()
    expect(states.at(-1)?.loading).toBe(false)
    expect(states.at(-1)?.loadError).toBeNull()
    expect(states.at(-1)?.files).toEqual(['example.txt'])
  })

  it('lists a repo-less SSH folder workspace after folder metadata hydrates', async () => {
    const states: RuntimeFileListState[] = []
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')

    useAppStore.setState({
      folderWorkspaces: [],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)

    await renderProbe({
      enabled: true,
      states,
      worktreeId: workspaceKey
    })

    expect(listRuntimeFilesMock).not.toHaveBeenCalled()

    await act(async () => {
      useAppStore.setState({
        folderWorkspaces: [makeFolderWorkspace({ connectionId: 'ssh-1' })],
        projectGroups: [makeProjectGroup({ connectionId: 'ssh-1' })],
        repos: [],
        worktreesByRepo: {}
      } as Partial<AppState>)
    })
    await waitForListRuntimeFilesCall()

    expect(listRuntimeFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: workspaceKey,
        worktreePath: '/srv/platform',
        connectionId: 'ssh-1',
        settings: expect.objectContaining({ activeRuntimeEnvironmentId: null })
      }),
      {
        includeIgnored: true,
        followSymlinks: false,
        rootPath: '/srv/platform',
        excludePaths: undefined,
        requestToken: expect.any(String),
        // #12547: the caller names the cap so a full page is readable as truncation.
        maxResults: QUICK_OPEN_LISTING_MAX_RESULTS,
        signal: expect.any(AbortSignal)
      }
    )
    expect(states.at(-1)?.files).toEqual(['packages/app/package.json'])
    expect(states.at(-1)?.truncated).toBe(false)
  })

  // #12547: the host stops at the cap the caller names, so a full page is a prefix. Reporting
  // truncated:false unconditionally is what left the user with a silent partial list.
  it('reports a capped listing as truncated instead of as the whole workspace', async () => {
    const states: RuntimeFileListState[] = []
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    listRuntimeFilesMock.mockResolvedValue(
      Array.from({ length: QUICK_OPEN_LISTING_MAX_RESULTS }, (_, i) => `src/file-${i}.ts`)
    )

    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ connectionId: 'ssh-1' })],
      projectGroups: [makeProjectGroup({ connectionId: 'ssh-1' })],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)

    await renderProbe({
      enabled: true,
      states,
      worktreeId: workspaceKey
    })
    await waitForListRuntimeFilesCall()

    expect(states.at(-1)?.files).toHaveLength(QUICK_OPEN_LISTING_MAX_RESULTS)
    expect(states.at(-1)?.truncated).toBe(true)
  })

  it('routes paired folder workspace queries to the owning runtime', async () => {
    vi.useFakeTimers()
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      settings: { ...initialAppState.settings, activeRuntimeEnvironmentId: 'env-1' },
      folderWorkspaces: [
        makeFolderWorkspace({ connectionId: null, executionHostId: 'runtime:env-1' })
      ],
      projectGroups: [makeProjectGroup({ connectionId: null, executionHostId: 'runtime:env-1' })],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)
    searchRuntimeFilePathsMock.mockResolvedValue({
      files: ['notes/remote-folder.md'],
      truncated: false
    })

    try {
      await renderProbe({
        enabled: true,
        states: [],
        query: 'remote-folder',
        worktreeId: workspaceKey
      })
      await act(async () => vi.advanceTimersByTimeAsync(120))

      expect(searchRuntimeFilePathsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: workspaceKey,
          worktreePath: '/srv/platform'
        }),
        expect.objectContaining({ query: 'remote-folder', limit: 32 })
      )
      expect(listRuntimeFilesMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the in-flight scan with the same request token on unmount (#7721)', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')

    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ connectionId: 'ssh-1' })],
      projectGroups: [makeProjectGroup({ connectionId: 'ssh-1' })],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)

    const root = await renderProbe({
      enabled: true,
      states: [],
      worktreeId: workspaceKey
    })
    await waitForListRuntimeFilesCall()

    const [listContext, listRequest] = listRuntimeFilesMock.mock.calls[0]
    expect(cancelRuntimeFileListMock).not.toHaveBeenCalled()

    await act(async () => {
      root.unmount()
    })

    expect(cancelRuntimeFileListMock).toHaveBeenCalledWith(listContext, listRequest.requestToken)
  })

  it('cancels the in-flight scan as soon as listing is disabled', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    listRuntimeFilesMock.mockReturnValue(new Promise<string[]>(() => {}))

    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ connectionId: 'ssh-1' })],
      projectGroups: [makeProjectGroup({ connectionId: 'ssh-1' })],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)

    const root = await renderProbe({
      enabled: true,
      states: [],
      worktreeId: workspaceKey
    })
    await waitForListRuntimeFilesCall()

    const [listContext, listRequest] = listRuntimeFilesMock.mock.calls[0]
    expect(listContext.connectionId).toBe('ssh-1')
    expect(cancelRuntimeFileListMock).not.toHaveBeenCalled()

    await act(async () => {
      root.render(
        createElement(HookProbe, {
          enabled: false,
          states: [],
          worktreeId: workspaceKey
        })
      )
    })
    await flushEffects()

    expect(cancelRuntimeFileListMock).toHaveBeenCalledTimes(1)
    expect(cancelRuntimeFileListMock).toHaveBeenCalledWith(listContext, listRequest.requestToken)
  })

  it('does not restart the scan when unrelated ownership metadata changes', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ connectionId: 'ssh-1' })],
      projectGroups: [makeProjectGroup({ connectionId: 'ssh-1' })],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)

    await renderProbe({ enabled: true, states: [], worktreeId: workspaceKey })
    await waitForListRuntimeFilesCall()

    await act(async () => {
      useAppStore.setState({
        repos: [
          {
            id: 'unrelated-repo',
            path: '/tmp/unrelated',
            displayName: 'Unrelated',
            badgeColor: '#000',
            addedAt: 0
          }
        ]
      } as Partial<AppState>)
    })
    await flushEffects()

    expect(listRuntimeFilesMock).toHaveBeenCalledTimes(1)
    expect(cancelRuntimeFileListMock).not.toHaveBeenCalled()
  })

  it('searches the owning runtime after the query debounce without listing all paths', async () => {
    vi.useFakeTimers()
    const states: RuntimeFileListState[] = []
    seedRemoteWorktree()
    searchRuntimeFilePathsMock.mockResolvedValue({
      files: ['data/sta-4354-target.ts'],
      truncated: true
    })

    try {
      await renderProbe({
        enabled: true,
        states,
        query: 'sta-4354-target',
        worktreeId: 'wt-remote'
      })

      expect(searchRuntimeFilePathsMock).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTimeAsync(120))
      await flushEffects()

      expect(searchRuntimeFilePathsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-remote',
          worktreePath: '/srv/remote'
        }),
        {
          includeIgnored: true,
          followSymlinks: false,
          query: 'sta-4354-target',
          limit: 32,
          excludePaths: undefined,
          signal: expect.any(AbortSignal)
        }
      )
      expect(listRuntimeFilesMock).not.toHaveBeenCalled()
      expect(states.at(-1)).toMatchObject({
        files: ['data/sta-4354-target.ts'],
        loading: false,
        truncated: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads a bounded remote inventory for empty-query history', async () => {
    seedRemoteWorktree()

    const states: RuntimeFileListState[] = []
    await renderProbe({
      enabled: true,
      states,
      query: '   ',
      worktreeId: 'wt-remote'
    })

    expect(searchRuntimeFilePathsMock).not.toHaveBeenCalled()
    expect(listRuntimeFilesMock).toHaveBeenCalledOnce()
    expect(states.at(-1)).toMatchObject({
      files: ['packages/app/package.json'],
      loading: false,
      truncated: false
    })
  })

  it('does not send oversized remote queries', async () => {
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []

    await renderProbe({
      enabled: true,
      states,
      query: 'x'.repeat(QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS + 1),
      worktreeId: 'wt-remote'
    })

    expect(searchRuntimeFilePathsMock).not.toHaveBeenCalled()
    expect(states.at(-1)).toMatchObject({ files: [], loading: false, truncated: false })
  })

  it('clears settled remote results when the query is cleared', async () => {
    vi.useFakeTimers()
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []
    searchRuntimeFilePathsMock.mockResolvedValue({
      files: ['src/target.ts'],
      truncated: false
    })

    try {
      const root = await renderProbe({
        enabled: true,
        states,
        query: 'target',
        worktreeId: 'wt-remote'
      })
      await act(async () => vi.advanceTimersByTimeAsync(120))
      await flushEffects()
      expect(states.at(-1)?.files).toEqual(['src/target.ts'])

      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            states,
            query: '',
            worktreeId: 'wt-remote'
          })
        )
      })
      await flushEffects()

      expect(searchRuntimeFilePathsMock).toHaveBeenCalledTimes(1)
      expect(states.at(-1)).toMatchObject({
        files: ['packages/app/package.json'],
        loading: false,
        truncated: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves remote full-list callers that do not opt into query search', async () => {
    seedRemoteWorktree()
    listRuntimeFilesMock.mockResolvedValue(['src/existing.ts'])

    const states: RuntimeFileListState[] = []
    await renderProbe({
      enabled: true,
      states,
      worktreeId: 'wt-remote'
    })
    await waitForListRuntimeFilesCall()

    expect(searchRuntimeFilePathsMock).not.toHaveBeenCalled()
    expect(states.at(-1)?.files).toEqual(['src/existing.ts'])
  })

  it('aborts superseded runtime queries and ignores stale replies', async () => {
    vi.useFakeTimers()
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []
    let resolveFirst!: (value: { files: string[]; truncated: boolean }) => void
    let resolveSecond!: (value: { files: string[]; truncated: boolean }) => void
    searchRuntimeFilePathsMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      )

    try {
      const root = await renderProbe({
        enabled: true,
        states,
        query: 'tar',
        worktreeId: 'wt-remote'
      })
      await act(async () => vi.advanceTimersByTimeAsync(120))
      const firstSignal = searchRuntimeFilePathsMock.mock.calls[0]?.[1].signal as AbortSignal

      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            states,
            query: 'target',
            worktreeId: 'wt-remote'
          })
        )
      })
      expect(firstSignal.aborted).toBe(true)
      await act(async () => vi.advanceTimersByTimeAsync(120))

      await act(async () => {
        resolveSecond({ files: ['src/target.ts'], truncated: false })
        await Promise.resolve()
      })
      expect(states.at(-1)?.files).toEqual(['src/target.ts'])

      await act(async () => {
        resolveFirst({ files: ['src/stale-target.ts'], truncated: true })
        await Promise.resolve()
      })
      expect(states.at(-1)).toMatchObject({
        files: ['src/target.ts'],
        truncated: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never renders the previous listing once the remote query changes', async () => {
    vi.useFakeTimers()
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []
    searchRuntimeFilePathsMock.mockResolvedValue({ files: ['src/tar.ts'], truncated: true })

    try {
      const root = await renderProbe({
        enabled: true,
        states,
        query: 'tar',
        worktreeId: 'wt-remote'
      })
      await act(async () => vi.advanceTimersByTimeAsync(120))
      await flushEffects()
      expect(states.at(-1)).toMatchObject({ files: ['src/tar.ts'], truncated: true })

      const rendersBeforeChange = states.length
      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            states,
            query: 'target',
            worktreeId: 'wt-remote'
          })
        )
      })

      // Why: the render before the effect restarts the request is the one that can leak.
      expect(states.length).toBeGreaterThan(rendersBeforeChange)
      for (const state of states.slice(rendersBeforeChange)) {
        expect(state).toMatchObject({ files: [], loading: true, truncated: false })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the new remote query as loading after the previous one failed', async () => {
    vi.useFakeTimers()
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []
    searchRuntimeFilePathsMock.mockRejectedValue(new Error('scan failed'))

    try {
      const root = await renderProbe({
        enabled: true,
        states,
        query: 'tar',
        worktreeId: 'wt-remote'
      })
      await act(async () => vi.advanceTimersByTimeAsync(120))
      await flushEffects()
      expect(states.at(-1)).toMatchObject({ files: [], loading: false, loadError: 'scan failed' })

      const rendersBeforeChange = states.length
      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            states,
            query: 'target',
            worktreeId: 'wt-remote'
          })
        )
      })

      expect(states.length).toBeGreaterThan(rendersBeforeChange)
      for (const state of states.slice(rendersBeforeChange)) {
        expect(state).toMatchObject({ files: [], loading: true })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the local listing across query changes without restarting it', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)
    const states: RuntimeFileListState[] = []

    const root = await renderProbe({
      enabled: true,
      states,
      query: 'one',
      worktreeId: workspaceKey
    })
    await waitForListRuntimeFilesCall()
    await flushEffects()
    expect(states.at(-1)?.files).toEqual(['packages/app/package.json'])

    await act(async () => {
      root.render(
        createElement(HookProbe, {
          enabled: true,
          states,
          query: 'two',
          worktreeId: workspaceKey
        })
      )
    })
    await flushEffects()

    expect(listRuntimeFilesMock).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toMatchObject({
      files: ['packages/app/package.json'],
      loading: false
    })
  })
})

it('merges host-eligible history beyond remote top32 once per palette lifetime', async () => {
  vi.useFakeTimers()
  try {
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []
    searchRuntimeFilePathsMock.mockResolvedValue({
      files: Array.from({ length: 32 }, (_, i) => `src/file${i}.ts`),
      truncated: true
    })
    listRuntimeFilesMock.mockResolvedValue(['src/file99.ts'])
    const args = {
      enabled: true,
      worktreeId: 'wt-remote',
      query: 'file',
      recentPaths: ['src/file99.ts', 'src/deleted.ts'],
      states
    }
    const root = await renderProbe(args)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(states.at(-1)?.files).toContain('src/file99.ts')
    expect(states.at(-1)?.files).not.toContain('src/deleted.ts')
    expect(listRuntimeFilesMock).toHaveBeenCalledOnce()
    expect(listRuntimeFilesMock.mock.calls[0][1]).toMatchObject({
      candidatePaths: args.recentPaths,
      maxResults: 2
    })
    await act(async () => {
      root.render(createElement(HookProbe, { ...args, query: 'file9' }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(listRuntimeFilesMock).toHaveBeenCalledOnce()
    await act(async () => {
      root.render(createElement(HookProbe, { ...args, enabled: false }))
    })
    await act(async () => {
      root.render(createElement(HookProbe, args))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(listRuntimeFilesMock).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps ordinary remote search available when recent eligibility is unsupported', async () => {
  vi.useFakeTimers()
  try {
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []
    searchRuntimeFilePathsMock.mockResolvedValue({ files: ['src/file0.ts'], truncated: true })
    listRuntimeFilesMock.mockRejectedValue(new Error('Update the remote host'))
    await renderProbe({
      enabled: true,
      worktreeId: 'wt-remote',
      query: 'file',
      recentPaths: ['src/file99.ts'],
      states
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(states.at(-1)?.files).toEqual(['src/file0.ts'])
    expect(states.at(-1)?.loadError).toBeNull()
    expect(states.at(-1)?.recentError).toContain('Update the remote host')
  } finally {
    vi.useRealTimers()
  }
})

it('merges an eligible recent beyond the local empty-query inventory cap', async () => {
  vi.useFakeTimers()
  try {
    const workspace = makeFolderWorkspace()
    useAppStore.setState({ folderWorkspaces: [workspace], projectGroups: [makeProjectGroup()] })
    const states: RuntimeFileListState[] = []
    listRuntimeFilesMock.mockImplementation((_context, args) =>
      Promise.resolve(
        args.candidatePaths
          ? ['late.ts']
          : Array.from({ length: QUICK_OPEN_LISTING_MAX_RESULTS }, (_, i) => `file${i}.ts`)
      )
    )
    await renderProbe({
      enabled: true,
      worktreeId: folderWorkspaceKey(workspace.id),
      query: '',
      recentPaths: ['late.ts'],
      states
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    await flushEffects()
    expect(states.at(-1)?.files).toContain('late.ts')
    expect(states.at(-1)?.truncated).toBe(true)
    expect(listRuntimeFilesMock).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})
