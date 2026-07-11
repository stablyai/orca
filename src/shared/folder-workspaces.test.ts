import { describe, expect, it } from 'vitest'
import { normalizeFolderWorkspaces } from './folder-workspaces'
import type { FolderWorkspace, ProjectGroup } from './types'

const folderGroup: ProjectGroup = {
  id: 'g1',
  name: 'Platform',
  parentPath: '/workspace/platform',
  connectionId: null,
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

function makeWorkspace(overrides: Partial<FolderWorkspace> & { id: string }): FolderWorkspace {
  return {
    projectGroupId: 'g1',
    name: 'WS',
    folderPath: '/workspace/platform',
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

describe('normalizeFolderWorkspaces (mission-owned)', () => {
  it('keeps mission-owned workspaces when their mission exists', () => {
    const result = normalizeFolderWorkspaces(
      [makeWorkspace({ id: 'fw1', projectGroupId: 'mission:m1', missionId: 'm1' })],
      [],
      [{ id: 'm1', rootPath: '/home/orca/missions/referral' }]
    )
    expect(result).toHaveLength(1)
    expect(result[0].missionId).toBe('m1')
    expect(result[0].projectGroupId).toBe('mission:m1')
  })

  it('drops mission-owned workspaces whose mission is gone', () => {
    const result = normalizeFolderWorkspaces(
      [makeWorkspace({ id: 'fw1', projectGroupId: 'mission:m1', missionId: 'm1' })],
      [folderGroup],
      []
    )
    expect(result).toHaveLength(0)
  })

  it('falls back mission workspace folderPath to the mission rootPath', () => {
    const result = normalizeFolderWorkspaces(
      [
        makeWorkspace({
          id: 'fw1',
          projectGroupId: 'mission:m1',
          missionId: 'm1',
          folderPath: ''
        })
      ],
      [],
      [{ id: 'm1', rootPath: '/home/orca/missions/referral' }]
    )
    expect(result[0].folderPath).toBe('/home/orca/missions/referral')
  })

  it('keeps group-owned behavior unchanged (orphans still drop)', () => {
    const result = normalizeFolderWorkspaces(
      [makeWorkspace({ id: 'ok' }), makeWorkspace({ id: 'orphan', projectGroupId: 'missing' })],
      [folderGroup],
      []
    )
    expect(result.map((ws) => ws.id)).toEqual(['ok'])
  })
})
