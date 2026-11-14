import { afterEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import { findFolderWorkspaceOwner } from '@/lib/workspace/ownership/folder-workspace-runtime-owner'
import { createProjectGroup } from '../../../../shared/project-groups'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'

// The host publishes the row before setup preparation returns the create reply.
it('keeps the created workspace activatable when its catalog arrives before setup', async () => {
  const store = createTestStore()
  const group = createProjectGroup({
    name: 'Services',
    parentPath: '/services',
    createdFrom: 'folder-scan',
    tabOrder: 0
  })
  const workspace: FolderWorkspace = {
    id: 'created-folder',
    projectGroupId: group.id,
    name: 'Feature',
    folderPath: '/services',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
  const twin = { ...workspace, executionHostId: 'runtime:other' as const }
  const setup = {
    runnerScriptPath: '/services/.orca/setup-runner/setup.sh',
    envVars: {},
    waitForAgentStartup: true
  }
  store.setState({ projectGroups: [group], folderWorkspaces: [twin] })
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: {
        create: async () => {
          store.setState({
            folderWorkspaces: [
              { ...workspace, name: 'Latest catalog name', executionHostId: 'local' },
              twin
            ]
          })
          return { folderWorkspace: workspace, setup }
        }
      }
    }
  })
  const result = await store
    .getState()
    .createFolderWorkspace({ projectGroupId: group.id }, { runtimeEnvironmentId: null })
  expect(result?.setup).toEqual({
    runnerScriptPath: '/services/.orca/setup-runner/setup.sh',
    envVars: {},
    waitForAgentStartup: true
  })
  expect(store.getState().folderWorkspaces.map((row) => row.executionHostId)).toEqual([
    'local',
    'runtime:other'
  ])
  expect(findFolderWorkspaceOwner(store.getState(), 'created-folder', 'local')).toMatchObject({
    id: 'created-folder',
    executionHostId: 'local'
  })
  expect(
    findFolderWorkspaceOwner(store.getState(), 'created-folder', 'runtime:other')
  ).toMatchObject({
    id: 'created-folder',
    executionHostId: 'runtime:other'
  })
  expect(store.getState().folderWorkspaces.map((row) => row.name)).toEqual([
    'Latest catalog name',
    'Feature'
  ])
})

afterEach(() => vi.unstubAllGlobals())

import { mergeCreatedFolderWorkspace } from './folder-workspace-catalog'

it('merges a created row with fleet catalogs in one owner and row pass', () => {
  const group = createProjectGroup({
    name: 'Services',
    parentPath: '/services',
    createdFrom: 'folder-scan',
    tabOrder: 0
  })
  const workspace: FolderWorkspace = {
    id: 'new',
    projectGroupId: 'group-0',
    name: 'Feature',
    folderPath: '/services',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
  for (const size of [750, 7500]) {
    let groupReads = 0
    let rowReads = 0
    const groups = Array.from({ length: size }, (_, i) => ({
      ...group,
      get id() {
        groupReads += 1
        return `group-${i}`
      }
    }))
    const rows = Array.from({ length: size }, (_, i) => ({
      ...workspace,
      projectGroupId: `group-${i}`,
      get id() {
        rowReads += 1
        return `existing-${i}`
      }
    }))
    const result = mergeCreatedFolderWorkspace(workspace, rows, groups)
    expect(result).toHaveLength(size + 1)
    expect(result[0]).toBe(workspace)
    // Preserving N rows requires N identities; indexing G owners reads each key for lookup and insert.
    expect(rowReads).toBeLessThanOrEqual(size + 1)
    expect(groupReads).toBeLessThanOrEqual(2 * size)
  }
})
