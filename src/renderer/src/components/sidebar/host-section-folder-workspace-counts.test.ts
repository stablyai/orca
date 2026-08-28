import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Row } from './worktree-list/grouping/row-types'
import { addHostSectionRows, type HostSectionOption } from './host-section-rows'

const LOCAL_REPO: Repo = {
  id: 'local-repo',
  path: '/local-repo',
  displayName: 'Local',
  badgeColor: '#000000',
  addedAt: 0
}

const LOCAL_WORKTREE: Worktree = {
  id: 'local-worktree',
  repoId: LOCAL_REPO.id,
  path: '/local-repo/worktree',
  branch: 'refs/heads/main',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
  displayName: 'Local worktree',
  sortOrder: 0,
  lastActivityAt: 0
}

const HOSTS: HostSectionOption[] = [
  { id: 'local', kind: 'local', label: 'Local', detail: 'This computer', health: 'local' },
  { id: 'ssh:builder', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
]

const LOCAL_ROW: Extract<Row, { type: 'item' }> = {
  type: 'item',
  rowKey: 'local-worktree',
  sectionKey: 'all',
  worktree: LOCAL_WORKTREE,
  repo: LOCAL_REPO,
  depth: 0,
  groupDepth: 0,
  lineageTrail: [],
  isLastLineageChild: true,
  lineageChildCount: 0
}

const PROJECT_GROUP: ProjectGroup = {
  id: 'group-1',
  name: 'Remote folder',
  parentPath: '/srv/project',
  connectionId: 'builder',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const FOLDER_ROW: Extract<Row, { type: 'folder-workspace' }> = {
  type: 'folder-workspace',
  key: 'folder-workspace:folder-1',
  folderWorkspace: {
    id: 'folder-1',
    projectGroupId: PROJECT_GROUP.id,
    name: 'Remote folder workspace',
    folderPath: '/srv/project',
    connectionId: 'builder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  },
  projectGroup: PROJECT_GROUP,
  depth: 0,
  groupDepth: 0
}

function hostCounts(rows: readonly Row[]) {
  return addHostSectionRows({
    rows,
    hostOptions: HOSTS,
    workspaceHostScope: 'all',
    defaultHostId: 'local'
  })
    .filter((row) => row.type === 'host-header')
    .map(({ hostId, count }) => ({ hostId, count }))
}

describe('folder workspace host counts', () => {
  it('counts an expanded folder workspace row', () => {
    expect(hostCounts([LOCAL_ROW, FOLDER_ROW])).toEqual([
      { hostId: 'local', count: 1 },
      { hostId: 'ssh:builder', count: 1 }
    ])
  })

  it('counts a collapsed folder-only lane from its header', () => {
    const collapsedLane: Extract<Row, { type: 'header' }> = {
      type: 'header',
      key: 'workspace-status:in-progress',
      label: 'In progress',
      count: 1,
      tone: 'text-foreground',
      hostWorktreeCounts: new Map([['ssh:builder', 1]]),
      hostWorktreeIds: new Map([['ssh:builder', []]])
    }

    expect(hostCounts([collapsedLane, LOCAL_ROW])).toEqual([
      { hostId: 'local', count: 1 },
      { hostId: 'ssh:builder', count: 1 }
    ])
  })
})
