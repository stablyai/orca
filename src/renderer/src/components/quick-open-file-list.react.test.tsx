// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Worktree } from '../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useRuntimeFileListForWorktree, type RuntimeFileListState } from './quick-open-file-list'
import { QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS } from './quick-open-search'

const listRuntimeFilesMock = vi.hoisted(() => vi.fn())
const cancelRuntimeFileListMock = vi.hoisted(() => vi.fn())
const searchRuntimeFilePathsMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-file-client', () => ({
  listRuntimeFiles: listRuntimeFilesMock,
  cancelRuntimeFileList: cancelRuntimeFileListMock,
  searchRuntimeFilePaths: searchRuntimeFilePathsMock
}))

const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/srv/platform',
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'Platform workspace',
    folderPath: '/srv/platform',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRemoteWorktree(): Worktree {
  return {
    id: 'wt-remote',
    repoId: 'repo-remote',
    hostId: 'runtime:env-1',
    runtimeOwnerEnvironmentId: 'env-1',
    path: '/srv/remote',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'Remote',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function seedRemoteWorktree(): void {
  useAppStore.setState({
    settings: { ...initialAppState.settings, activeRuntimeEnvironmentId: 'env-1' },
    repos: [],
    worktreesByRepo: { 'repo-remote': [makeRemoteWorktree()] }
  } as Partial<AppState>)
}

function HookProbe({
  enabled,
  onState,
  query,
  worktreeId
}: {
  enabled: boolean
  onState: (state: RuntimeFileListState) => void
  query?: string
  worktreeId: string | null
}): null {
  onState(useRuntimeFileListForWorktree({ enabled, worktreeId, query }))
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function waitForListRuntimeFilesCall(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushEffects()
    if (listRuntimeFilesMock.mock.calls.length > 0) {
      return
    }
  }
  throw new Error('listRuntimeFiles was not called')
}

async function renderProbe(args: {
  enabled: boolean
  onState: (state: RuntimeFileListState) => void
  query?: string
  worktreeId: string | null
}): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, args))
  })
  await flushEffects()
  return root
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  listRuntimeFilesMock.mockReset().mockResolvedValue(['packages/app/package.json'])
  cancelRuntimeFileListMock.mockReset()
  searchRuntimeFilePathsMock.mockReset().mockResolvedValue({ files: [], truncated: false })
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
  useAppStore.setState(initialAppState, true)
})

describe('useRuntimeFileListForWorktree', () => {
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
      onState: (state) => states.push(state),
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
        rootPath: '/srv/platform',
        excludePaths: undefined,
        requestToken: expect.any(String),
        signal: expect.any(AbortSignal)
      }
    )
    expect(states.at(-1)?.files).toEqual(['packages/app/package.json'])
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
        onState: () => {},
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
      onState: () => {},
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
      onState: () => {},
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
          onState: () => {},
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

    await renderProbe({ enabled: true, onState: () => {}, worktreeId: workspaceKey })
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
        onState: (state) => states.push(state),
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

  it('does not request a remote inventory for an empty query', async () => {
    seedRemoteWorktree()

    const states: RuntimeFileListState[] = []
    await renderProbe({
      enabled: true,
      onState: (state) => states.push(state),
      query: '   ',
      worktreeId: 'wt-remote'
    })

    expect(searchRuntimeFilePathsMock).not.toHaveBeenCalled()
    expect(listRuntimeFilesMock).not.toHaveBeenCalled()
    expect(states.at(-1)).toMatchObject({ files: [], loading: false, truncated: false })
  })

  it('does not send oversized remote queries', async () => {
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []

    await renderProbe({
      enabled: true,
      onState: (state) => states.push(state),
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
        onState: (state) => states.push(state),
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
            onState: (state: RuntimeFileListState) => states.push(state),
            query: '',
            worktreeId: 'wt-remote'
          })
        )
      })
      await flushEffects()

      expect(searchRuntimeFilePathsMock).toHaveBeenCalledTimes(1)
      expect(states.at(-1)).toMatchObject({ files: [], loading: false, truncated: false })
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
      onState: (state) => states.push(state),
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
        onState: (state) => states.push(state),
        query: 'tar',
        worktreeId: 'wt-remote'
      })
      await act(async () => vi.advanceTimersByTimeAsync(120))
      const firstSignal = searchRuntimeFilePathsMock.mock.calls[0]?.[1].signal as AbortSignal

      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            onState: (state: RuntimeFileListState) => states.push(state),
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

  it('does not restart local listings when only the query changes', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)

    const root = await renderProbe({
      enabled: true,
      onState: () => {},
      query: 'one',
      worktreeId: workspaceKey
    })
    await waitForListRuntimeFilesCall()

    await act(async () => {
      root.render(
        createElement(HookProbe, {
          enabled: true,
          onState: () => {},
          query: 'two',
          worktreeId: workspaceKey
        })
      )
    })
    await flushEffects()

    expect(listRuntimeFilesMock).toHaveBeenCalledTimes(1)
  })
})
