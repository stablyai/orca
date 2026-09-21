import { describe, expect, it } from 'vitest'
import {
  resolveClaudeHomeBindingForGroup,
  resolveClaudeHomeBindingForWorkspace,
  resolveProjectGroupIdForWorkspace
} from './claude-home-binding'
import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'

function group(overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id'>): ProjectGroup {
  return {
    name: overrides.id,
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

function repo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: `/work/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function folderWorkspace(
  overrides: Partial<FolderWorkspace> & Pick<FolderWorkspace, 'id' | 'projectGroupId'>
): FolderWorkspace {
  return {
    name: overrides.id,
    folderPath: `/work/${overrides.id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('resolveClaudeHomeBindingForGroup', () => {
  it('returns the group\u2019s own binding', () => {
    const groups = [group({ id: 'a', claudeConfigDir: '/homes/a' })]
    expect(resolveClaudeHomeBindingForGroup(groups, 'a')).toEqual({
      configDir: '/homes/a',
      groupId: 'a'
    })
  })

  it('prefers the nearest bound ancestor over a further one', () => {
    const groups = [
      group({ id: 'root', claudeConfigDir: '/homes/root' }),
      group({ id: 'mid', parentGroupId: 'root', claudeConfigDir: '/homes/mid' }),
      group({ id: 'leaf', parentGroupId: 'mid' })
    ]
    expect(resolveClaudeHomeBindingForGroup(groups, 'leaf')).toEqual({
      configDir: '/homes/mid',
      groupId: 'mid'
    })
  })

  it('walks past unbound ancestors to the furthest binding', () => {
    const groups = [
      group({ id: 'root', claudeConfigDir: '/homes/root' }),
      group({ id: 'mid', parentGroupId: 'root' }),
      group({ id: 'leaf', parentGroupId: 'mid' })
    ]
    expect(resolveClaudeHomeBindingForGroup(groups, 'leaf')).toEqual({
      configDir: '/homes/root',
      groupId: 'root'
    })
  })

  it('returns null for an unbound tree, an unknown group, and no group', () => {
    const groups = [group({ id: 'root' }), group({ id: 'leaf', parentGroupId: 'root' })]
    expect(resolveClaudeHomeBindingForGroup(groups, 'leaf')).toBeNull()
    expect(resolveClaudeHomeBindingForGroup(groups, 'missing')).toBeNull()
    expect(resolveClaudeHomeBindingForGroup(groups, null)).toBeNull()
    expect(resolveClaudeHomeBindingForGroup(groups, undefined)).toBeNull()
  })

  it('terminates on a self-parent that survived normalization', () => {
    const groups = [group({ id: 'a', parentGroupId: 'a' })]
    expect(resolveClaudeHomeBindingForGroup(groups, 'a')).toBeNull()
  })

  it('terminates on a two-group cycle that survived normalization', () => {
    const groups = [group({ id: 'a', parentGroupId: 'b' }), group({ id: 'b', parentGroupId: 'a' })]
    expect(resolveClaudeHomeBindingForGroup(groups, 'a')).toBeNull()
  })

  it('terminates on a dangling parentGroupId', () => {
    const groups = [group({ id: 'leaf', parentGroupId: 'gone' })]
    expect(resolveClaudeHomeBindingForGroup(groups, 'leaf')).toBeNull()
  })

  it('ignores a blank or null binding and keeps walking', () => {
    const groups = [
      group({ id: 'root', claudeConfigDir: '/homes/root' }),
      group({ id: 'leaf', parentGroupId: 'root', claudeConfigDir: null })
    ]
    expect(resolveClaudeHomeBindingForGroup(groups, 'leaf')).toEqual({
      configDir: '/homes/root',
      groupId: 'root'
    })
  })
})

describe('resolveProjectGroupIdForWorkspace', () => {
  it('maps a repo-backed worktree through Repo.projectGroupId', () => {
    expect(
      resolveProjectGroupIdForWorkspace({
        repos: [repo({ id: 'repo-1', projectGroupId: 'a' })],
        folderWorkspaces: [],
        workspaceId: 'repo-1::/work/repo-1/feature'
      })
    ).toBe('a')
  })

  it('maps a folder workspace through its own projectGroupId', () => {
    expect(
      resolveProjectGroupIdForWorkspace({
        repos: [],
        folderWorkspaces: [folderWorkspace({ id: 'fw-1', projectGroupId: 'b' })],
        workspaceId: 'fw-1'
      })
    ).toBe('b')
  })

  it('accepts a folder workspace id wrapped in a workspace key', () => {
    expect(
      resolveProjectGroupIdForWorkspace({
        repos: [],
        folderWorkspaces: [folderWorkspace({ id: 'fw-1', projectGroupId: 'b' })],
        workspaceId: 'folder:fw-1'
      })
    ).toBe('b')
  })

  it('returns null for an ungrouped repo and an unknown workspace', () => {
    expect(
      resolveProjectGroupIdForWorkspace({
        repos: [repo({ id: 'repo-1' })],
        folderWorkspaces: [],
        workspaceId: 'repo-1::/work/repo-1'
      })
    ).toBeNull()
    expect(
      resolveProjectGroupIdForWorkspace({
        repos: [],
        folderWorkspaces: [],
        workspaceId: 'nope::/x'
      })
    ).toBeNull()
  })
})

describe('resolveClaudeHomeBindingForWorkspace', () => {
  it('composes the workspace lookup with the ancestor walk', () => {
    expect(
      resolveClaudeHomeBindingForWorkspace({
        groups: [
          group({ id: 'root', claudeConfigDir: '/homes/root' }),
          group({ id: 'leaf', parentGroupId: 'root' })
        ],
        repos: [repo({ id: 'repo-1', projectGroupId: 'leaf' })],
        folderWorkspaces: [],
        workspaceId: 'repo-1::/work/repo-1/feature'
      })
    ).toEqual({ configDir: '/homes/root', groupId: 'root' })
  })

  it('resolves a folder workspace to its group\u2019s binding', () => {
    expect(
      resolveClaudeHomeBindingForWorkspace({
        groups: [group({ id: 'b', claudeConfigDir: 'C:\\homes\\b' })],
        repos: [],
        folderWorkspaces: [folderWorkspace({ id: 'fw-1', projectGroupId: 'b' })],
        workspaceId: 'fw-1'
      })
    ).toEqual({ configDir: 'C:\\homes\\b', groupId: 'b' })
  })

  it('returns null when the workspace has no group', () => {
    expect(
      resolveClaudeHomeBindingForWorkspace({
        groups: [group({ id: 'a', claudeConfigDir: '/homes/a' })],
        repos: [repo({ id: 'repo-1' })],
        folderWorkspaces: [],
        workspaceId: 'repo-1::/work/repo-1'
      })
    ).toBeNull()
  })
})
