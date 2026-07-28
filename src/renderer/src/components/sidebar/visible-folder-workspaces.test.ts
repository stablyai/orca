import { describe, expect, it } from 'vitest'
import { computeVisibleFolderWorkspaces } from './visible-folder-workspaces'
import type { FolderWorkspace, ProjectGroup, TerminalTab } from '../../../../shared/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

function makeTab(id: string, worktreeId: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeFolderWorkspace(
  id: string,
  overrides: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  return {
    id,
    projectGroupId: 'group-1',
    name: id,
    folderPath: `/tmp/${id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('computeVisibleFolderWorkspaces', () => {
  it('always drops archived folder workspaces, even with sleeping shown', () => {
    const active = makeFolderWorkspace('fw-active')
    const archived = makeFolderWorkspace('fw-archived', { isArchived: true })

    expect(
      computeVisibleFolderWorkspaces([active, archived], {
        projectGroupById: new Map<string, ProjectGroup>(),
        visibleHostIdSet: null,
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        showSleepingWorkspaces: true,
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: null,
        worktreeIdsWithLiveAgent: new Set<string>()
      })
    ).toEqual([active])
  })

  it('drops archived folder workspaces even when they have a live agent', () => {
    const archived = makeFolderWorkspace('fw-archived-live', { isArchived: true })

    expect(
      computeVisibleFolderWorkspaces([archived], {
        projectGroupById: new Map<string, ProjectGroup>(),
        visibleHostIdSet: null,
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        showSleepingWorkspaces: false,
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: null,
        worktreeIdsWithLiveAgent: new Set([folderWorkspaceKey(archived.id)])
      })
    ).toEqual([])
  })

  it('hides sleeping folder workspaces when the filter is on', () => {
    const awake = makeFolderWorkspace('fw-awake')
    const asleep = makeFolderWorkspace('fw-asleep')
    const opts: Parameters<typeof computeVisibleFolderWorkspaces>[1] = {
      projectGroupById: new Map<string, ProjectGroup>(),
      visibleHostIdSet: null,
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      showSleepingWorkspaces: false,
      tabsByWorktree: {
        [folderWorkspaceKey(awake.id)]: [
          makeTab('tab-awake', folderWorkspaceKey(awake.id), 'pty-1')
        ]
      },
      ptyIdsByTabId: { 'tab-awake': ['pty-1'] },
      browserTabsByWorktree: null,
      worktreeIdsWithLiveAgent: new Set<string>()
    }

    expect(computeVisibleFolderWorkspaces([awake, asleep], opts)).toEqual([awake])
    expect(
      computeVisibleFolderWorkspaces([awake, asleep], { ...opts, showSleepingWorkspaces: true })
    ).toEqual([awake, asleep])
  })

  it('keeps folder workspaces with a live agent visible', () => {
    const headless = makeFolderWorkspace('fw-headless')

    expect(
      computeVisibleFolderWorkspaces([headless], {
        projectGroupById: new Map<string, ProjectGroup>(),
        visibleHostIdSet: null,
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        showSleepingWorkspaces: false,
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: null,
        worktreeIdsWithLiveAgent: new Set([folderWorkspaceKey(headless.id)])
      })
    ).toEqual([headless])
  })

  it('applies the host scope filter via the owning project group connection', () => {
    const localWorkspace = makeFolderWorkspace('fw-local')
    const sshWorkspace = makeFolderWorkspace('fw-ssh', { connectionId: 'vm-1' })

    expect(
      computeVisibleFolderWorkspaces([localWorkspace, sshWorkspace], {
        projectGroupById: new Map<string, ProjectGroup>(),
        visibleHostIdSet: new Set([LOCAL_EXECUTION_HOST_ID]),
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        showSleepingWorkspaces: true,
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: null,
        worktreeIdsWithLiveAgent: new Set<string>()
      })
    ).toEqual([localWorkspace])
  })
})
