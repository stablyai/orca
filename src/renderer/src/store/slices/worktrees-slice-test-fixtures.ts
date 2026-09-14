import { vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'

export function makeWorktree(
  overrides: Partial<Worktree> & { id: string; repoId: string }
): Worktree {
  return {
    path: '/tmp/wt',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

export function makeTerminalTab(
  overrides: Partial<TerminalTab> & { id: string; worktreeId: string }
) {
  return {
    ptyId: null,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

export function createWebview(overrides: Partial<Electron.WebviewTag> = {}): Electron.WebviewTag {
  return Object.assign(new EventTarget(), {
    style: {},
    blur: vi.fn(),
    remove: vi.fn(),
    contains: vi.fn(() => false),
    ...overrides
  }) as unknown as Electron.WebviewTag
}

export function makeLineage(overrides: Partial<WorktreeLineage> = {}): WorktreeLineage {
  return {
    worktreeId: 'repo1::/path/child',
    worktreeInstanceId: 'child-instance',
    parentWorktreeId: 'repo1::/path/parent',
    parentWorktreeInstanceId: 'parent-instance',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1,
    ...overrides
  }
}
export function makeWorkspaceLineage(overrides: Partial<WorkspaceLineage> = {}): WorkspaceLineage {
  return {
    childWorkspaceKey: 'worktree:repo1::/path/child',
    childInstanceId: 'child-instance',
    parentWorkspaceKey: 'folder:folder-1',
    parentInstanceId: null,
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' },
    createdAt: 2,
    ...overrides
  }
}

export function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    ...overrides,
    id: overrides.id ?? 'folder-1',
    projectGroupId: overrides.projectGroupId ?? 'group-1',
    name: overrides.name ?? 'platform workspace',
    folderPath: overrides.folderPath ?? '/work/platform',
    linkedTask: overrides.linkedTask ?? null,
    comment: overrides.comment ?? '',
    isArchived: overrides.isArchived ?? false,
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    sortOrder: overrides.sortOrder ?? 0,
    manualOrder: overrides.manualOrder ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 0,
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
    workspaceStatus: overrides.workspaceStatus ?? 'active'
  }
}
