import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import { createTestStore } from './store-test-helpers'

function group(index: number): ProjectGroup {
  const ownerIndex = index % 16
  return {
    id: index < 16 ? 'same-id' : `group-${index}`,
    name: `Group ${index}`,
    parentPath: ownerIndex === 0 && index === 0 ? '/workspace' : null,
    executionHostId: ownerIndex === 0 ? 'local' : `runtime:env-${ownerIndex}`,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: index,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('project-group path-status catalog cache', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reuses the owner-scoped snapshot without rescanning 12,208 repo paths', async () => {
    let pathReads = 0
    const projectGroups = Array.from({ length: 12_208 }, (_, index) => group(index))
    const repos = Array.from({ length: 12_208 }, (_, index) => {
      const ownerIndex = index % 16
      return {
        id: `repo-${index}`,
        get path() {
          pathReads += 1
          return `/workspace/repo-${index}`
        },
        displayName: `Repo ${index}`,
        badgeColor: '#000',
        addedAt: 1,
        projectGroupId: ownerIndex === 0 ? 'same-id' : null,
        executionHostId: ownerIndex === 0 ? 'local' : `runtime:env-${ownerIndex}`
      } as Repo
    })
    const getPathStatus = vi.fn().mockResolvedValue({ path: '/workspace', exists: true })
    vi.stubGlobal('window', { api: { folderWorkspaces: { getPathStatus } } })
    const store = createTestStore()
    store.setState({ projectGroups, repos })
    const request = { scope: 'project-group' as const, projectGroupId: 'same-id' }
    const options = { force: true, runtimeEnvironmentId: null, ownerHostId: 'local' as const }

    await store.getState().fetchFolderWorkspacePathStatus(request, options)
    const readsAfterFirstSnapshot = pathReads
    await store.getState().fetchFolderWorkspacePathStatus(request, options)

    expect(readsAfterFirstSnapshot).toBe(0)
    expect(pathReads).toBe(readsAfterFirstSnapshot)
    expect(getPathStatus).toHaveBeenCalledTimes(2)
  })

  it('indexes a large same-id folder catalog once per status read', () => {
    let groupIdReads = 0
    const projectGroups: ProjectGroup[] = Array.from(
      { length: 512 },
      (_, index): ProjectGroup => ({
        ...group(index),
        get id() {
          groupIdReads += 1
          return `group-${index}`
        }
      })
    )
    const folderWorkspaces = projectGroups.map(
      (projectGroup, index) =>
        ({
          id: 'same-folder',
          projectGroupId: projectGroup.id,
          name: `Folder ${index}`,
          folderPath: `/workspace/${index}`,
          executionHostId: normalizeExecutionHostId(projectGroup.executionHostId),
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: index,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1
        }) satisfies FolderWorkspace
    )
    groupIdReads = 0
    const store = createTestStore()
    store.setState({ projectGroups, folderWorkspaces })

    store.getState().getFreshFolderWorkspacePathStatus({
      scope: 'folder-workspace',
      folderWorkspaceId: 'same-folder',
      ownerHostId: 'runtime:env-1'
    })

    expect(groupIdReads).toBeLessThan(4_096)
  })

  it('builds every group snapshot with linear catalog work', () => {
    let groupIdReads = 0
    const projectGroups: ProjectGroup[] = Array.from({ length: 512 }, (_, index) => ({
      ...group(index),
      parentPath: `/workspace/${index}`,
      executionHostId: 'local',
      parentGroupId: index === 0 ? null : 'group-0',
      get id() {
        groupIdReads += 1
        return `group-${index}`
      }
    }))
    groupIdReads = 0
    const store = createTestStore()
    store.setState({ projectGroups })

    for (let index = 0; index < projectGroups.length; index++) {
      store
        .getState()
        .getFreshFolderWorkspacePathStatus(
          { scope: 'project-group', projectGroupId: `group-${index}` },
          { ownerHostId: 'local' }
        )
    }

    expect(groupIdReads).toBeLessThan(16_384)
  })
})
