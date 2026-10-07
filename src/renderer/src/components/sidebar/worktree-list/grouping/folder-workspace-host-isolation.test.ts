import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows'
import type { WorktreeGroupBy } from './row-types'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import {
  makeFolderWorkspace,
  makeWorkspaceLineage
} from '@/store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'

const group: ProjectGroup = {
  id: 'group',
  name: 'Group',
  parentPath: '/parent',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
const modes: WorktreeGroupBy[] = ['none', 'repo', 'workspace-status', 'pr-status']

function rows(mode: WorktreeGroupBy, hideRemote = false, collapseRemote = false) {
  const local = {
    ...worktree,
    id: 'local-child',
    hostId: 'local' as const,
    instanceId: 'local-instance'
  }
  const remote = {
    ...worktree,
    id: 'remote-child',
    hostId: 'ssh:box' as const,
    instanceId: 'remote-instance'
  }
  const children = [local, remote]
  const folders = [
    makeFolderWorkspace({ id: 'same-id', projectGroupId: group.id, executionHostId: 'local' }),
    ...(!hideRemote
      ? [
          makeFolderWorkspace({
            id: 'same-id',
            projectGroupId: group.id,
            executionHostId: 'ssh:box'
          })
        ]
      : [])
  ]
  const lineage = Object.fromEntries(
    children.map((child) => [
      worktreeWorkspaceKey(child.id),
      makeWorkspaceLineage({
        childWorkspaceKey: worktreeWorkspaceKey(child.id),
        childInstanceId: child.instanceId,
        parentWorkspaceKey: folderWorkspaceKey('same-id')
      })
    ])
  )
  return buildRows(
    mode,
    children,
    new Map([[repo.id, repo]]),
    null,
    new Set(collapseRemote ? ['folder-attached:ssh:box|same-id'] : []),
    undefined,
    undefined,
    'manual',
    {},
    new Map(children.map((child) => [child.id, child])),
    false,
    undefined,
    [group],
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    folders,
    undefined,
    'local',
    undefined,
    lineage
  )
}

describe('folder attachment host isolation', () => {
  it.each(modes)('keeps same-id folders and their children separate in %s', (mode) => {
    const result = rows(mode)
    const folders = result.filter((row) => row.type === 'folder-workspace')
    const children = result.filter((row) => row.type === 'item')
    expect(folders).toHaveLength(2)
    expect(new Set(folders.map((row) => row.key)).size).toBe(2)
    expect(folders.map((row) => row.attachedChildCount)).toEqual([1, 1])
    expect(children.map((row) => [row.worktree.id, row.sectionKey])).toEqual([
      ['local-child', 'folder:local|same-id'],
      ['remote-child', 'folder:ssh:box|same-id']
    ])
  })
  it('keeps a remote child visible when only the same-id local folder renders', () => {
    const result = rows('none', true)
    const remote = result.find((row) => row.type === 'item' && row.worktree.id === 'remote-child')
    expect(remote).toMatchObject({ sectionKey: 'all' })
  })
  it('collapses only the requested host folder', () => {
    const result = rows('none', false, true)
    expect(result.filter((row) => row.type === 'item').map((row) => row.worktree.id)).toEqual([
      'local-child'
    ])
  })
})
