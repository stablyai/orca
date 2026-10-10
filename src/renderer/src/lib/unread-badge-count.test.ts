import { describe, expect, it } from 'vitest'
import { makeTab } from '../store/slices/store-session-test-harness'
import { makeWorktree, TEST_REPO } from '../store/slices/worktrees-slice-test-fixtures'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getUnreadBadgeCount, type UnreadBadgeCountSources } from './unread-badge-count'

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return makeWorktree({ id, repoId: TEST_REPO.id, isUnread: true, ...overrides })
}

function projectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'platform',
    parentPath: '/work',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function count(overrides: Partial<UnreadBadgeCountSources>): number {
  return getUnreadBadgeCount({
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [projectGroup()],
    repoMap: new Map([[TEST_REPO.id, TEST_REPO]]),
    visibleHostIds: null,
    defaultHostId: 'local',
    hiddenOtherDevicePairings: null,
    ...overrides,
    // These visibility fixtures represent folder bells with live tab owners.
    tabsByWorktree:
      overrides.tabsByWorktree ??
      Object.fromEntries(
        (overrides.folderWorkspaces ?? []).map((folder) => [
          `folder:${folder.id}`,
          [makeTab({ id: `bell:${folder.id}`, worktreeId: `folder:${folder.id}` })]
        ])
      ),
    unreadTerminalTabs:
      overrides.unreadTerminalTabs ??
      Object.fromEntries(
        (overrides.folderWorkspaces ?? []).map((folder) => [
          `bell:${folder.id}`,
          'terminal-bell' as const
        ])
      )
  })
}

describe('getUnreadBadgeCount', () => {
  it('counts unread worktrees', () => {
    expect(
      count({
        worktreesByRepo: { repo1: [worktree('wt-1'), worktree('wt-2', { isUnread: false })] }
      })
    ).toBe(1)
  })

  it('skips archived worktrees, which the sidebar never shows', () => {
    expect(count({ worktreesByRepo: { repo1: [worktree('wt-1', { isArchived: true })] } })).toBe(0)
  })

  it('preserves id-only deduplication across execution hosts', () => {
    const rows = [worktree('wt-1', { hostId: 'local' }), worktree('wt-1', { hostId: 'ssh:remote' })]
    expect(count({ worktreesByRepo: { repo1: rows } })).toBe(1)
    expect(count({ worktreesByRepo: { repo1: rows }, visibleHostIds: new Set(['local']) })).toBe(1)
  })

  it('counts a row repeated across repo buckets once', () => {
    expect(
      count({
        worktreesByRepo: {
          'repo-a': [worktree('wt-1', { hostId: 'local' })],
          'repo-b': [worktree('wt-1', { hostId: 'local' })]
        }
      })
    ).toBe(1)
  })

  it('counts unread folder workspaces alongside worktrees', () => {
    expect(
      count({
        worktreesByRepo: { repo1: [worktree('wt-1')] },
        folderWorkspaces: [
          makeFolderWorkspace({ id: 'folder-1', isUnread: true }),
          makeFolderWorkspace({ id: 'folder-2' })
        ]
      })
    ).toBe(2)
  })

  it('uses the same other-device policy for git worktrees as for folder rows', () => {
    const foreign = worktree('foreign', {
      creatorProvenance: { kind: 'paired-device', deviceId: 'phone' }
    })
    expect(count({ worktreesByRepo: { repo1: [foreign] } })).toBe(1)
    expect(
      count({ worktreesByRepo: { repo1: [foreign] }, hiddenOtherDevicePairings: new Map() })
    ).toBe(0)
    const runtimeOwned = { ...foreign, runtimeOwnerEnvironmentId: 'env' }
    expect(
      count({
        worktreesByRepo: { repo1: [runtimeOwned] },
        hiddenOtherDevicePairings: new Map([['env', 'phone']])
      })
    ).toBe(1)
    expect(
      count({
        worktreesByRepo: { repo1: [runtimeOwned] },
        hiddenOtherDevicePairings: new Map([['env', 'other']])
      })
    ).toBe(0)
  })

  it('adds no flag-only folder or orphan-marker counts', () => {
    const folderWorkspaces = [makeFolderWorkspace({ isUnread: true })]
    expect(count({ folderWorkspaces, unreadTerminalTabs: {} })).toBe(0)
    expect(
      count({
        folderWorkspaces,
        tabsByWorktree: {},
        unreadTerminalTabs: { orphan: 'terminal-bell' }
      })
    ).toBe(0)
  })

  it('skips an unread folder workspace the sidebar has no row for', () => {
    const localOnly = { visibleHostIds: new Set(['local'] as const) }
    const remoteFolderInLocalGroup = {
      folderWorkspaces: [makeFolderWorkspace({ isUnread: true, executionHostId: 'ssh:ssh-1' })]
    }
    const localFolderInRemoteGroup = {
      folderWorkspaces: [makeFolderWorkspace({ isUnread: true, executionHostId: 'local' })],
      projectGroups: [projectGroup({ connectionId: 'ssh-1' })]
    }

    expect(count(remoteFolderInLocalGroup)).toBe(1)
    expect(count({ ...remoteFolderInLocalGroup, ...localOnly })).toBe(0)
    expect(count(localFolderInRemoteGroup)).toBe(1)
    expect(count({ ...localFolderInRemoteGroup, ...localOnly })).toBe(0)
    // A group with no folder on disk renders no rows.
    expect(
      count({
        folderWorkspaces: [makeFolderWorkspace({ isUnread: true })],
        projectGroups: [projectGroup({ parentPath: null })]
      })
    ).toBe(0)
  })

  it('skips a folder workspace from another device while the sidebar hides those', () => {
    const fromOtherDevice = makeFolderWorkspace({
      isUnread: true,
      creatorProvenance: { kind: 'paired-device', deviceId: 'phone' }
    })

    expect(count({ folderWorkspaces: [fromOtherDevice] })).toBe(1)
    expect(
      count({ folderWorkspaces: [fromOtherDevice], hiddenOtherDevicePairings: new Map() })
    ).toBe(0)
  })
})
