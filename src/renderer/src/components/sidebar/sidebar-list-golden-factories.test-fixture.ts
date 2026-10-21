import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { PRState } from '../../../../shared/github/pull-request-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'

/** Fixed clock for every golden capture; Recent sort and create grace read it. */
export const GOLDEN_NOW = Date.UTC(2026, 9, 1, 12, 0, 0)

const BASE_WORKTREE: Omit<Worktree, 'id' | 'repoId' | 'path' | 'displayName'> = {
  branch: 'refs/heads/feature',
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
  sortOrder: 0,
  lastActivityAt: 0
}

export function wt(repo: Repo, slug: string, overrides: Partial<Worktree> = {}): Worktree {
  const path = `/w/${slug}`
  return {
    ...BASE_WORKTREE,
    id: `${repo.id}::${path}`,
    instanceId: `instance-${repo.id}-${slug}`,
    repoId: repo.id,
    path,
    displayName: slug,
    branch: `refs/heads/${slug}`,
    ...overrides
  }
}

export function mainWt(repo: Repo, overrides: Partial<Worktree> = {}): Worktree {
  return {
    ...BASE_WORKTREE,
    id: `${repo.id}::${repo.path}`,
    instanceId: `instance-${repo.id}-main`,
    repoId: repo.id,
    path: repo.path,
    displayName: 'main',
    branch: 'refs/heads/main',
    isMainWorktree: true,
    ...overrides
  }
}

export function repo(id: string, displayName: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName,
    badgeColor: '#737373',
    addedAt: 1,
    ...overrides
  }
}

export function group(
  id: string,
  name: string,
  overrides: Partial<ProjectGroup> = {}
): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
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

export function folder(
  id: string,
  projectGroupId: string,
  overrides: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/folders/${id}`,
    connectionId: null,
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

export function lineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    createdAt: 1
  }
}

export function prEntry(number: number, state: PRState): AppState['prCache'][string] {
  return {
    data: {
      number,
      state,
      title: `PR ${number}`,
      url: `https://github.com/stablyai/orca/pull/${number}`,
      checksStatus: 'success',
      updatedAt: '2026-10-01T00:00:00Z',
      mergeable: 'MERGEABLE'
    },
    fetchedAt: GOLDEN_NOW
  }
}
