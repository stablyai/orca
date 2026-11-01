// Share locally stored folder rows (without host stamps) and saved partitions across main routing/window-save tests.
import type { ExecutionHostId } from './execution-host'
import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'

function makeGroup(overrides: Partial<ProjectGroup>): ProjectGroup {
  return {
    id: 'group-mixed',
    name: 'group',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    connectionId: null,
    ...overrides
  }
}

function makeFolder(overrides: Partial<FolderWorkspace>): FolderWorkspace {
  return {
    id: 'notes-1',
    projectGroupId: 'group-mixed',
    name: 'notes',
    folderPath: '/Users/dev/notes',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    createdAt: 1,
    lastActivityAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

/** A local group holding a local repo and an SSH repo: its folders have no single host. */
export const MIXED_GROUP = makeGroup({})
/** Imported from a remote root, so it carries the target, yet it also holds a local repo. */
const SSH_GROUP = makeGroup({ id: 'group-ssh', connectionId: 'target-1' })

export const ROUTING_REPOS = [
  { id: 'repo-1', path: '/Users/dev/orca', projectGroupId: MIXED_GROUP.id, connectionId: null },
  {
    id: 'repo-ssh',
    path: '/home/dev/api',
    projectGroupId: MIXED_GROUP.id,
    connectionId: 'target-1'
  },
  { id: 'repo-local-2', path: '/Users/dev/web', projectGroupId: SSH_GROUP.id, connectionId: null }
]

export const MIXED_FOLDER = makeFolder({})

export const FOLDER_HOST_CASES: {
  name: string
  folder: FolderWorkspace
  groups: ProjectGroup[]
  expected: ExecutionHostId
}[] = [
  {
    name: 'in a local group with local and SSH repos',
    folder: MIXED_FOLDER,
    groups: [MIXED_GROUP],
    expected: 'local'
  },
  {
    name: 'in an SSH group that also holds a local repo',
    folder: makeFolder({ projectGroupId: SSH_GROUP.id }),
    groups: [SSH_GROUP],
    expected: 'ssh:target-1'
  },
  {
    name: 'with its own SSH target, in an SSH group holding a local repo',
    folder: makeFolder({ projectGroupId: SSH_GROUP.id, connectionId: 'target-1' }),
    groups: [SSH_GROUP],
    expected: 'ssh:target-1'
  },
  {
    name: 'with its own SSH target and no stamp (legacy), in a local group',
    folder: makeFolder({ connectionId: 'target-1' }),
    groups: [MIXED_GROUP],
    expected: 'ssh:target-1'
  },
  {
    name: 'stamped with a host',
    folder: makeFolder({ executionHostId: 'ssh:target-2' }),
    groups: [MIXED_GROUP],
    expected: 'ssh:target-2'
  },
  {
    name: 'inside an SSH repo but with no target of its own',
    folder: makeFolder({ folderPath: '/home/dev/api/docs' }),
    groups: [MIXED_GROUP],
    expected: 'local'
  },
  {
    name: 'in a group main does not list',
    folder: makeFolder({ projectGroupId: 'gone' }),
    groups: [],
    expected: 'local'
  }
]
