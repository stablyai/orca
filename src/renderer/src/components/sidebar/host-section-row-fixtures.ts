import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'
import type { Row } from './worktree-list/grouping/row-types'
import type { HostSectionRow } from './host-section-rows'

export function repo(id: string, connectionId?: string | null): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId
  }
}

export function worktree(id: string, repoId: string): Worktree {
  return {
    id,
    repoId,
    path: `/${repoId}/${id}`,
    branch: `refs/heads/${id}`,
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
    displayName: id,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

export function header(key: string, label = key): Extract<Row, { type: 'header' }> {
  return {
    type: 'header',
    key,
    label,
    count: 1,
    tone: 'text-foreground'
  }
}

export function pinnedHeader(
  counts: ReadonlyMap<ExecutionHostId, number>,
  idsByHost?: ReadonlyMap<ExecutionHostId, readonly string[]>
): Extract<Row, { type: 'header' }> {
  return {
    ...header(PINNED_GROUP_KEY, 'Pinned'),
    count: Array.from(counts.values()).reduce((sum, count) => sum + count, 0),
    hostWorktreeCounts: counts,
    hostWorktreeIds: idsByHost,
    worktreeIds: idsByHost ? Array.from(idsByHost.values()).flat() : undefined
  }
}

export function repoHeader(project: Repo): Extract<Row, { type: 'header' }> {
  return {
    ...header(`repo:${project.id}`, project.displayName),
    repo: project
  }
}

export function item(id: string, project: Repo): Extract<Row, { type: 'item' }> {
  const sectionKey = `repo:${project.id}`
  return {
    type: 'item',
    rowKey: `${sectionKey}:${id}`,
    sectionKey,
    worktree: worktree(id, project.id),
    repo: project,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: true,
    lineageChildCount: 0
  }
}

export function pinnedItem(
  id: string,
  project: Repo,
  sectionKey: string
): Extract<Row, { type: 'item' }> {
  const row = item(id, project)
  row.worktree.isPinned = true
  row.rowKey = `${sectionKey}:${id}`
  row.sectionKey = sectionKey
  return row
}

export function folderWorkspaceRow(
  connectionId: string | null,
  groupExecutionHostId?: ExecutionHostId,
  folderExecutionHostId?: ExecutionHostId
): Extract<Row, { type: 'folder-workspace' }> {
  const projectGroup: ProjectGroup = {
    id: 'group-1',
    name: 'Remote folder',
    parentPath: '/srv/project',
    connectionId,
    ...(groupExecutionHostId ? { executionHostId: groupExecutionHostId } : {}),
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const folderWorkspace: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: projectGroup.id,
    name: 'Folder workspace',
    folderPath: '/srv/project',
    connectionId,
    ...(folderExecutionHostId ? { executionHostId: folderExecutionHostId } : {}),
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  return {
    type: 'folder-workspace',
    key: 'folder-workspace:folder-1',
    folderWorkspace,
    projectGroup,
    depth: 0,
    groupDepth: 0
  }
}

export function rowKey(row: HostSectionRow): string {
  return row.type === 'item' ? row.worktree.id : row.key
}
