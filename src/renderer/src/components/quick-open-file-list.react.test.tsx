// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../shared/types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useRuntimeFileListForWorktree, type RuntimeFileListState } from './quick-open-file-list'

const listRuntimeFilesMock = vi.hoisted(() => vi.fn())
const cancelRuntimeFileListMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-file-client', () => ({
  listRuntimeFiles: listRuntimeFilesMock,
  cancelRuntimeFileList: cancelRuntimeFileListMock
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

function HookProbe({
  enabled,
  onState,
  worktreeId
}: {
  enabled: boolean
  onState: (state: RuntimeFileListState) => void
  worktreeId: string | null
}): null {
  onState(useRuntimeFileListForWorktree({ enabled, worktreeId }))
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
        requestToken: expect.any(String)
      }
    )
    expect(states.at(-1)?.files).toEqual(['packages/app/package.json'])
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
})
