import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { FolderWorkspaceItemRow } from '../listing/renderable-rows'
import { renderFolderWorkspaceVirtualRow, type FolderWorkspaceRowContext } from './folder-row'

function row(executionHostId: 'local' | 'runtime:env-1'): FolderWorkspaceItemRow {
  const folderWorkspace = {
    id: 'folder-shared',
    projectGroupId: 'group-shared',
    name: executionHostId,
    folderPath: `/${executionHostId}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    executionHostId
  } satisfies FolderWorkspace
  const projectGroup = {
    id: folderWorkspace.projectGroupId,
    name: executionHostId,
    parentPath: folderWorkspace.folderPath,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    executionHostId
  } satisfies ProjectGroup
  return {
    type: 'folder-workspace',
    key: `folder-workspace:${executionHostId}`,
    folderWorkspace,
    projectGroup,
    depth: 0,
    groupDepth: 0
  }
}

function render(target: FolderWorkspaceItemRow): React.ReactElement<Record<string, unknown>> {
  const ctx = {
    defaultHostId: 'local',
    groupBy: 'none',
    newCardStyle: false,
    settings: {} as FolderWorkspaceRowContext['settings'],
    activeWorktreeId: folderWorkspaceKey(target.folderWorkspace.id),
    activeWorkspaceExecutionHostId: 'runtime:env-1',
    currentWorktreeId: folderWorkspaceKey(target.folderWorkspace.id),
    selectedWorktreeIds: new Set(),
    repoMap: new Map(),
    worktreeMap: new Map(),
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    prCache: null,
    hostedReviewCache: null,
    getCachedFolderWorkspacePathStatus: () => null,
    onSelectionGesture: () => false,
    onContextMenuSelect: () => [],
    onImmediateActivate: vi.fn(),
    onRowClickCapture: vi.fn(),
    onRowPointerDown: vi.fn()
  } satisfies FolderWorkspaceRowContext
  return renderFolderWorkspaceVirtualRow({
    ctx,
    row: target,
    vItem: { key: target.key, index: 0, start: 0 } as VirtualItem,
    measureVirtualRowElement: vi.fn()
  }) as React.ReactElement<Record<string, unknown>>
}

describe('folder row host identity', () => {
  it('keeps DOM identity and active state on the requested host', () => {
    const local = render(row('local'))
    const runtime = render(row('runtime:env-1'))

    expect(local.props.id).not.toBe(runtime.props.id)
    expect(local.props['data-worktree-row-key']).not.toBe(runtime.props['data-worktree-row-key'])
    expect(local.props['aria-current']).toBeUndefined()
    expect(runtime.props['aria-current']).toBe('page')
  })
})
