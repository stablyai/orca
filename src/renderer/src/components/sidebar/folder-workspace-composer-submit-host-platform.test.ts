// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'

const mocks = vi.hoisted(() => ({ activateAndRevealFolderWorkspace: vi.fn() }))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

import { useAppStore } from '@/store'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

function makeProjectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/repo/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeFolderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'hi',
    folderPath: '/repo/platform/hi',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

// Why: a folder group on an Orca server runs its agents there, so the server's OS decides quoting.
describe('submitFolderWorkspaceCreate on an Orca server', () => {
  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  })

  it('quotes quick-agent startup for the Orca server that owns the folder group', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const projectGroup = {
      ...makeProjectGroup(),
      executionHostId: 'runtime:win-box',
      parentPath: 'D:\\platform'
    }
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [
          'win-box',
          {
            checkedAt: 1,
            status: {
              runtimeId: 'rt',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              hostPlatform: 'win32'
            }
          }
        ]
      ])
    })

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'Server folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: "Use Bob's server startup",
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        startup: expect.objectContaining({ command: "claude 'Use Bob''s server startup'" })
      })
    )
  })

  it('refuses an agent launch on an Orca server that never reported its OS', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })

    await expect(
      submitFolderWorkspaceCreate({
        projectGroup: { ...makeProjectGroup(), executionHostId: 'runtime:silent-box' },
        name: 'Server folder',
        lastAutoName: '',
        linkedWorkItem: null,
        note: '',
        quickAgent: 'claude',
        autoRenameBranchFromWork: false,
        agentCmdOverrides: {},
        createFolderWorkspace,
        onOpenChange: vi.fn()
      })
    ).rejects.toThrow('has not reported its operating system')
    expect(createFolderWorkspace).not.toHaveBeenCalled()
  })
})
