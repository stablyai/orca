import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getFolderWorkspaceSidebarRowKey, type RenderRow } from '../listing/render-row'
import { getWorktreeOptionId } from '../rows/option-dom'
import { getActiveDescendantOptionId } from './active-descendant-option'

function row(hostId: Worktree['hostId']): WorktreeItemRow {
  return {
    type: 'item',
    rowKey: `all:${hostId}|shared`,
    sectionKey: 'all',
    worktree: { id: 'shared', repoId: 'repo', hostId } as Worktree,
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

describe('getActiveDescendantOptionId', () => {
  it('announces the active host row when workspace ids collide', () => {
    const local = row('local')
    const ssh = row('ssh:box')

    expect(
      getActiveDescendantOptionId({
        activeWorktreeId: 'shared',
        activeWorkspaceExecutionHostId: 'ssh:box',
        pinnedDisplayPolicy: 'single-location',
        renderRows: [local, ssh],
        virtualItems: [{ index: 0 }, { index: 1 }]
      })
    ).toBe(getWorktreeOptionId(ssh.rowKey))
  })

  it('announces the active host folder row when workspace ids collide', () => {
    const workspace = {
      id: 'folder-shared',
      projectGroupId: 'group-shared'
    } as FolderWorkspace
    const group = { id: 'group-shared' } as ProjectGroup
    const rows = ['local', 'runtime:env-1'].map((executionHostId) => ({
      type: 'folder-workspace',
      key: `folder-workspace:${executionHostId}`,
      folderWorkspace: { ...workspace, executionHostId },
      projectGroup: { ...group, executionHostId },
      depth: 0,
      groupDepth: 0
    })) as RenderRow[]

    expect(
      getActiveDescendantOptionId({
        activeWorktreeId: folderWorkspaceKey(workspace.id),
        activeWorkspaceExecutionHostId: 'runtime:env-1',
        pinnedDisplayPolicy: 'single-location',
        renderRows: rows,
        virtualItems: [{ index: 0 }, { index: 1 }]
      })
    ).toBe(
      getWorktreeOptionId(
        getFolderWorkspaceSidebarRowKey(
          rows[1] as Extract<RenderRow, { type: 'folder-workspace' }>,
          'runtime:env-1'
        )
      )
    )
  })
})
