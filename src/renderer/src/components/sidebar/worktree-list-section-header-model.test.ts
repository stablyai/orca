import { describe, expect, it } from 'vitest'
import type { ProjectGroup, Repo } from '../../../../shared/types'
import type { GroupHeaderRow } from './worktree-list-groups'
import { getWorktreeListSectionHeaderModel } from './worktree-list-section-header-model'

type ModelArgs = Parameters<typeof getWorktreeListSectionHeaderModel>[0]

function makeArgs(row: GroupHeaderRow, overrides: Partial<ModelArgs> = {}): ModelArgs {
  return {
    row,
    index: 0,
    renderRows: [row],
    firstHeaderIndex: 0,
    activeStickyHeaderIndex: null,
    activeStickyHostIndex: null,
    groupBy: 'none',
    canReorderRepoHeaders: false,
    canReorderProjectGroupHeaders: false,
    repoHeaderIndexByRepoId: new Map(),
    repoHeaderBucketByRepoId: new Map(),
    repoHeaderSectionEndByRepoId: new Map(),
    sidebarRepoHeaderIdsByBucket: new Map(),
    projectGroupHeaderIndexByGroupId: new Map(),
    projectGroupHeaderBucketByGroupId: new Map(),
    projectGroupHeaderSectionEndByGroupId: new Map(),
    sidebarProjectGroupHeaderIdsByBucket: new Map(),
    draggingRepoId: null,
    draggingProjectGroupId: null,
    workspaceStatuses: [],
    sshConnectionStates: new Map(),
    getCachedFolderWorkspacePathStatus: () => null,
    collapsedGroups: new Set(),
    ...overrides
  }
}

describe('getWorktreeListSectionHeaderModel', () => {
  it('keeps flat All headers non-collapsible beneath a sticky host header', () => {
    const row: GroupHeaderRow = {
      type: 'header',
      key: 'all',
      label: 'All',
      count: 2,
      tone: 'text-muted-foreground'
    }

    const model = getWorktreeListSectionHeaderModel(
      makeArgs(row, {
        activeStickyHeaderIndex: 0,
        activeStickyHostIndex: 3,
        collapsedGroups: new Set(['all'])
      })
    )

    expect(model).toMatchObject({
      isActiveStickyHeader: true,
      stickyTopClass: 'top-[35px]',
      showHeaderCollapseAffordance: false,
      isHeaderCollapsed: true,
      headerPaddingLeft: 10,
      createState: null,
      headerWorkspaceStatus: null,
      isPinnedHeader: false
    })
  })

  it('preserves reorder, nesting, and SSH reconnect state for repo headers', () => {
    const repo: Repo = {
      id: 'repo-remote',
      path: '/home/alice/orca',
      displayName: 'Orca',
      badgeColor: '#737373',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const row: GroupHeaderRow = {
      type: 'header',
      key: 'repo:repo-remote',
      label: 'Orca',
      count: 3,
      tone: 'text-muted-foreground',
      repo,
      projectGroupDepth: 2
    }

    const model = getWorktreeListSectionHeaderModel(
      makeArgs(row, {
        groupBy: 'repo',
        canReorderRepoHeaders: true,
        repoHeaderIndexByRepoId: new Map([[repo.id, 4]]),
        repoHeaderBucketByRepoId: new Map([[repo.id, 'host:ssh-1']]),
        repoHeaderSectionEndByRepoId: new Map([[repo.id, 7]]),
        sidebarRepoHeaderIdsByBucket: new Map([['host:ssh-1', [repo.id, 'repo-remote-peer']]]),
        draggingRepoId: repo.id,
        collapsedGroups: new Set([row.key]),
        sshConnectionStates: new Map([
          [
            'ssh-1',
            {
              targetId: 'ssh-1',
              status: 'disconnected',
              error: null,
              reconnectAttempt: 0
            }
          ]
        ])
      })
    )

    expect(model).toMatchObject({
      projectIdForHeader: repo.id,
      repoHeaderIndex: 4,
      repoHeaderBucketKey: 'host:ssh-1',
      repoHeaderSectionEnd: 7,
      isDraggableRepoHeader: true,
      isDraggingThis: true,
      showHeaderCollapseAffordance: true,
      isHeaderCollapsed: true,
      headerPaddingLeft: 30,
      repoHeaderColor: '#737373',
      createState: {
        disabled: true,
        requiresSshReconnect: true
      }
    })
  })

  it('maps pinned and custom workspace-status headers to collapsible sections', () => {
    const pinnedRow: GroupHeaderRow = {
      type: 'header',
      key: 'pinned',
      label: 'Pinned',
      count: 1,
      tone: 'text-muted-foreground'
    }
    const statusRow: GroupHeaderRow = {
      type: 'header',
      key: 'workspace-status:needs%20review',
      label: 'Needs review',
      count: 2,
      tone: 'text-muted-foreground'
    }

    expect(getWorktreeListSectionHeaderModel(makeArgs(pinnedRow))).toMatchObject({
      isPinnedHeader: true,
      headerWorkspaceStatus: null,
      showHeaderCollapseAffordance: true
    })
    expect(
      getWorktreeListSectionHeaderModel(
        makeArgs(statusRow, {
          groupBy: 'workspace-status',
          workspaceStatuses: [{ id: 'needs review', label: 'Needs review' }]
        })
      )
    ).toMatchObject({
      isPinnedHeader: false,
      headerWorkspaceStatus: 'needs review',
      showHeaderCollapseAffordance: true
    })
  })

  it.each([
    { path: '/missing', reason: 'missing' as const },
    { path: '/not-a-folder', reason: 'not-directory' as const },
    { path: '/ambiguous', reason: 'ambiguous-connection' as const }
  ])('disables folder-backed project creation for $reason paths', ({ path, reason }) => {
    const projectGroup: ProjectGroup = {
      id: 'group-folder',
      name: 'Folder projects',
      parentPath: '/projects',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const row: GroupHeaderRow = {
      type: 'header',
      key: `project-group:${projectGroup.id}`,
      label: projectGroup.name,
      count: 1,
      tone: 'text-muted-foreground',
      projectGroup
    }

    const model = getWorktreeListSectionHeaderModel(
      makeArgs(row, {
        groupBy: 'repo',
        getCachedFolderWorkspacePathStatus: (request) => {
          expect(request).toEqual({ scope: 'project-group', projectGroupId: projectGroup.id })
          return { path, exists: false, reason }
        }
      })
    )

    expect(model).toMatchObject({
      projectGroupIdForHeader: projectGroup.id,
      projectGroupPathStatus: { path, exists: false, reason },
      folderWorkspaceCreateDisabled: true,
      showHeaderCollapseAffordance: true
    })
  })

  it('keeps temporarily unavailable folder-backed project creation enabled', () => {
    const projectGroup: ProjectGroup = {
      id: 'group-unavailable',
      name: 'Remote projects',
      parentPath: '/remote/projects',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const row: GroupHeaderRow = {
      type: 'header',
      key: `project-group:${projectGroup.id}`,
      label: projectGroup.name,
      count: 1,
      tone: 'text-muted-foreground',
      projectGroup
    }

    const model = getWorktreeListSectionHeaderModel(
      makeArgs(row, {
        groupBy: 'repo',
        getCachedFolderWorkspacePathStatus: () => ({
          path: projectGroup.parentPath ?? '',
          exists: false,
          reason: 'unavailable'
        })
      })
    )

    expect(model.folderWorkspaceCreateDisabled).toBe(false)
  })
})
