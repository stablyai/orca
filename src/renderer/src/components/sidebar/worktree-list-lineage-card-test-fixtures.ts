import { vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

export function makeFolderWorkspacePathStatusMockState(): Record<string, unknown> {
  return {
    fetchFolderWorkspacePathStatus: vi.fn(),
    folderWorkspaces: [],
    folderWorkspacePathStatuses: {},
    getFolderWorkspacePathStatusCacheKey: (request: unknown) => JSON.stringify(request),
    getFreshFolderWorkspacePathStatus: () => null
  }
}

export function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/lineage-order',
    displayName: 'lineage-order',
    badgeColor: '#999999',
    addedAt: 1
  }
}

export function makeWorktree(args: {
  id: string
  displayName: string
  branch: string
  sortOrder: number
  instanceId: string
}): Worktree {
  return {
    id: args.id,
    instanceId: args.instanceId,
    repoId: 'repo-1',
    path: `/tmp/lineage-order/${args.id}`,
    displayName: args.displayName,
    branch: args.branch,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: args.sortOrder,
    lastActivityAt: args.sortOrder
  }
}

export function makeFolderWorkspacePathStatusState(): Record<string, unknown> {
  return {
    fetchFolderWorkspacePathStatus: vi.fn(),
    folderWorkspacePathStatuses: {},
    folderWorkspaces: [],
    getFolderWorkspacePathStatusCacheKey: (request: unknown) => JSON.stringify(request),
    getFreshFolderWorkspacePathStatus: vi.fn(() => null)
  }
}
