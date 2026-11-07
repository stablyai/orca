// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../../shared/quick-open-listing-limits'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RuntimeFileListState } from './quick-open-file-list'

import {
  listRuntimeFilesMock,
  searchRuntimeFilePathsMock,
  makeProjectGroup,
  makeFolderWorkspace,
  seedRemoteWorktree,
  HookProbe,
  flushEffects,
  waitForListRuntimeFilesCall,
  renderProbe
} from './quick-open-file-list-test-harness'

vi.mock('@/runtime/files/search/runtime-file-search-client', async () => {
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
        target: { kind: 'local' }
      }),
      {
        includeIgnored: true,
        followSymlinks: false,
        rootPath: '/srv/platform',
        excludePaths: undefined,
        requestToken: expect.any(String),
        maxResults: QUICK_OPEN_LISTING_MAX_RESULTS,
        signal: expect.any(AbortSignal)
      }
    )
    expect(states.at(-1)?.files).toEqual(['packages/app/package.json'])
    expect(states.at(-1)?.truncated).toBe(false)
  })

  // A full capped page is only a prefix; marking it complete would silently hide remaining paths (#12547).
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
