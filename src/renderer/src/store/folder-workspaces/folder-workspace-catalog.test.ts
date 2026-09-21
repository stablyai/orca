import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  getFolderWorkspaceCatalogReplacementIdentities,
  getFolderWorkspaceHostId,
  mergeFetchedFolderWorkspaceCatalog
} from './folder-workspace-catalog'

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/workspace/platform',
    parentGroupId: null,
    createdFrom: 'manual',
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
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Platform folder',
    folderPath: '/workspace/platform',
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

describe('folder workspace host resolution', () => {
  it.each([
    [
      'uses a normalized explicit host stamp',
      makeFolderWorkspace({ executionHostId: ' runtime:env-1 ' as never }),
      [],
      'runtime:env-1'
    ],
    [
      'uses a workspace SSH connection',
      makeFolderWorkspace({ connectionId: 'ssh-1' }),
      [],
      'ssh:ssh-1'
    ],
    [
      'uses the single owning project-group host',
      makeFolderWorkspace(),
      [makeProjectGroup({ executionHostId: 'runtime:env-1' })],
      'runtime:env-1'
    ],
    [
      'keeps duplicate project-group copies on one host',
      makeFolderWorkspace(),
      [
        makeProjectGroup({ executionHostId: 'runtime:env-1' }),
        makeProjectGroup({ executionHostId: 'runtime:env-1' })
      ],
      'runtime:env-1'
    ],
    [
      'falls back local for ambiguous project-group owners',
      makeFolderWorkspace(),
      [
        makeProjectGroup({ executionHostId: 'runtime:env-1' }),
        makeProjectGroup({ executionHostId: 'runtime:env-2' })
      ],
      'local'
    ]
  ])('%s', (_description, workspace, projectGroups, expectedHostId) => {
    expect(getFolderWorkspaceHostId(workspace, projectGroups)).toBe(expectedHostId)
  })

  it('indexes project-group hosts once while merging repeated workspace rows', () => {
    let hostReads = 0
    const projectGroup = makeProjectGroup()
    Object.defineProperty(projectGroup, 'executionHostId', {
      configurable: true,
      get: () => {
        hostReads += 1
        return 'runtime:env-1'
      }
    })
    const previous = Array.from({ length: 8 }, (_, index) =>
      makeFolderWorkspace({ id: `folder-${index}` })
    )
    const fetched = previous.map((workspace) => ({ ...workspace, name: 'Updated' }))

    const merged = mergeFetchedFolderWorkspaceCatalog(
      { folderWorkspaces: fetched, hostId: 'runtime:env-1' },
      previous,
      [projectGroup]
    )

    expect(merged.folderWorkspaces).toEqual(fetched)
    expect(hostReads).toBe(1)
  })

  it('reuses one host index for replacement identities', () => {
    let hostReads = 0
    const projectGroup = makeProjectGroup()
    Object.defineProperty(projectGroup, 'executionHostId', {
      configurable: true,
      get: () => {
        hostReads += 1
        return 'runtime:env-1'
      }
    })
    const rows = Array.from({ length: 8 }, (_, index) =>
      makeFolderWorkspace({ id: `folder-${index}` })
    )

    const identities = getFolderWorkspaceCatalogReplacementIdentities(
      { folderWorkspaces: rows, hostId: 'runtime:env-1' },
      rows,
      [projectGroup]
    )

    expect(identities).toHaveProperty('size', rows.length)
    expect(hostReads).toBe(1)
  })
})
