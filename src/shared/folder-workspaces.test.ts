import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeFolderWorkspaces } from './folder-workspaces'
import type { FolderWorkspace, ProjectGroup } from './types'

const platformPath = path.join(path.sep, 'workspace', 'platform')
const missionRootPath = path.join(path.sep, 'home', 'orca', 'missions', 'referral')

const folderGroup: ProjectGroup = {
  id: 'g1',
  name: 'Platform',
  parentPath: platformPath,
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
    folderPath: platformPath,
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
      [{ id: 'm1', name: 'Referral', rootPath: missionRootPath }]
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
      [{ id: 'm1', name: 'Referral', rootPath: missionRootPath }]
    )
    expect(result[0].folderPath).toBe(missionRootPath)
  })

  it('repairs stale Mission workspace identity and path from the owning Mission', () => {
    const result = normalizeFolderWorkspaces(
      [
        makeWorkspace({
          id: 'fw1',
          projectGroupId: 'mission:wrong',
          missionId: 'm1',
          name: 'Stale name',
          folderPath: path.join(path.sep, 'stale', 'root')
        })
      ],
      [],
      [{ id: 'm1', name: 'Referral', rootPath: missionRootPath }]
    )

    expect(result[0]).toMatchObject({
      projectGroupId: 'mission:m1',
      name: 'Referral',
      folderPath: missionRootPath
    })
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
