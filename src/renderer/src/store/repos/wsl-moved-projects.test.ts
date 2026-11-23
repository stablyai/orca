import { describe, expect, it } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import {
  canHideWslMovedEntry,
  selectListedWslMovedChatWorkspaces,
  wslMovedProjectOnHost,
  wslMovedRowOwnerHostId
} from './wsl-moved-projects'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project/groups/project-group-types'
import { TEST_REPO } from './repo.test-fixture'

function environment(
  id: string,
  orcadDeployment: PublicKnownRuntimeEnvironment['orcadDeployment']
): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'default',
    endpoints: [],
    orcadDeployment
  }
}

const ubuntu = environment('wsl-ubuntu', {
  kind: 'wsl',
  distro: 'Ubuntu',
  localPort: 4100,
  remotePort: 4200
})
const debian = environment('wsl-debian', {
  kind: 'wsl',
  distro: 'Debian',
  localPort: 4101,
  remotePort: 4201
})
const server = environment('server', undefined)

const moved: WslMovedProject = {
  kind: 'repo',
  id: 'repo-1',
  displayName: 'app',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app',
  distro: 'ubuntu'
}

describe('wslMovedProjectOnHost', () => {
  const environments = [ubuntu, debian, server]

  it('matches the row on the host of the distro the project moved to', () => {
    expect(wslMovedProjectOnHost(moved, environments, toRuntimeExecutionHostId(ubuntu.id))).toBe(
      moved
    )
  })

  it('ignores the same id on another host, a remote server, or this computer', () => {
    expect(
      wslMovedProjectOnHost(moved, environments, toRuntimeExecutionHostId(debian.id))
    ).toBeNull()
    expect(
      wslMovedProjectOnHost(moved, environments, toRuntimeExecutionHostId(server.id))
    ).toBeNull()
    expect(wslMovedProjectOnHost(moved, environments, 'local')).toBeNull()
    expect(
      wslMovedProjectOnHost(null, environments, toRuntimeExecutionHostId(ubuntu.id))
    ).toBeNull()
  })
})

describe('selectListedWslMovedChatWorkspaces', () => {
  const other: WslMovedProject = { ...moved, id: 'repo-2', displayName: 'other' }
  const groups = [
    { project: moved, workspaces: [] },
    { project: other, workspaces: [{ key: 'repo-2::/app', chats: [] }] }
  ]
  const hidden = ['ubuntu\u0000repo:repo-1', 'ubuntu\u0000repo:repo-2']
  function catalog(hostRepoIds: string[]) {
    return {
      repos: hostRepoIds.map((id) => ({
        ...TEST_REPO,
        id,
        executionHostId: toRuntimeExecutionHostId(ubuntu.id)
      })),
      folderWorkspaces: [],
      projectGroups: [],
      runtimeEnvironments: [ubuntu]
    }
  }

  it('hides hidden entries without chats whose host lists the project', () => {
    const listed = selectListedWslMovedChatWorkspaces(groups, hidden, catalog(['repo-1', 'repo-2']))
    expect(listed.map(({ project }) => project.id)).toEqual(['repo-2'])
  })

  it('lists a hidden entry again once its host no longer lists the project', () => {
    const listed = selectListedWslMovedChatWorkspaces(groups, hidden, catalog([]))
    expect(listed.map(({ project }) => project.id)).toEqual(['repo-1', 'repo-2'])
    expect(canHideWslMovedEntry(catalog([]), groups[0])).toBe(false)
  })
})

describe('a moved folder whose host comes only from its project group', () => {
  const folder: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'notes',
    folderPath: '/home/me/notes',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
  const group: ProjectGroup = {
    id: 'group-1',
    name: 'notes',
    parentPath: '/home/me',
    executionHostId: toRuntimeExecutionHostId(ubuntu.id),
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
  const movedFolder: WslMovedProject = {
    kind: 'folder',
    id: 'folder-1',
    displayName: 'notes',
    path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\notes',
    distro: 'Ubuntu'
  }
  const catalog = {
    repos: [],
    folderWorkspaces: [folder],
    projectGroups: [group],
    runtimeEnvironments: [ubuntu]
  }

  // The menu and the hide rule resolve the host alike, so the entry can be hidden and undone.
  it('counts as listed on its host and its row resolves to that host', () => {
    expect(canHideWslMovedEntry(catalog, { project: movedFolder, workspaces: [] })).toBe(true)
    expect(wslMovedRowOwnerHostId(catalog, { id: 'folder:folder-1', hostId: 'local' })).toBe(
      toRuntimeExecutionHostId(ubuntu.id)
    )
  })
})
