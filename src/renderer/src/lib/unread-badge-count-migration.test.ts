import { describe, expect, it } from 'vitest'
import { makeTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { getUnreadBadgeCount, type UnreadBadgeCountSources } from './unread-badge-count'

const projectGroup = {
  id: 'group-1',
  name: 'platform',
  parentPath: '/work',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
} satisfies ProjectGroup

const visibility = {
  projectGroups: [projectGroup],
  repoMap: new Map([[TEST_REPO.id, TEST_REPO]]),
  visibleHostIds: null,
  defaultHostId: 'local' as const,
  hiddenOtherDevicePairings: null
}

// The old count is the compatibility ceiling, including its orphan-marker behavior.
function baselineCount(sources: UnreadBadgeCountSources): number {
  const workspaces = new Set<string>()
  for (const rows of Object.values(sources.worktreesByRepo)) {
    for (const row of rows) {
      if (row.isUnread) {
        workspaces.add(row.id)
      }
    }
  }
  const markers = new Set(Object.keys(sources.unreadTerminalTabs ?? {}))
  for (const [key, tabs] of Object.entries(sources.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (markers.delete(tab.id)) {
        workspaces.add(key)
      }
    }
  }
  return workspaces.size + markers.size
}

describe('Dock count migration does not introduce hidden notifications', () => {
  it('never exceeds the old count across workspace, live-owner, and marker combinations', () => {
    // Host/device/group membership can only subtract from the baseline count.
    for (let bits = 0; bits < 256; bits += 1) {
      const enabled = (bit: number): boolean => (bits & (1 << bit)) !== 0
      const sources = {
        ...visibility,
        worktreesByRepo: {
          repo: [
            makeWorktree({
              id: 'same-id',
              repoId: TEST_REPO.id,
              hostId: 'local',
              isUnread: enabled(0),
              isArchived: enabled(1)
            }),
            makeWorktree({
              id: 'same-id',
              repoId: TEST_REPO.id,
              hostId: 'ssh:remote',
              isUnread: enabled(2),
              isArchived: false
            })
          ]
        },
        folderWorkspaces: [makeFolderWorkspace({ id: 'folder', isUnread: enabled(3) })],
        tabsByWorktree: {
          'folder:folder': enabled(4) ? [makeTab({ id: 'bell', worktreeId: 'folder:folder' })] : []
        },
        unifiedTabsByWorktree: {
          'folder:folder': enabled(5) ? [{ id: 'chat', contentType: 'agent-session' }] : []
        },
        unreadTerminalTabs: {
          ...(enabled(6) ? { bell: 'terminal-bell' as const } : {}),
          ...(enabled(7) ? { chat: 'terminal-bell' as const } : {}),
          orphan: 'terminal-bell' as const
        }
      } satisfies UnreadBadgeCountSources
      const hostFilters: UnreadBadgeCountSources['visibleHostIds'][] = [
        null,
        new Set(['local']),
        new Set(['ssh:remote']),
        new Set()
      ]
      const groupStates = [
        [projectGroup],
        [{ ...projectGroup, isCollapsed: true }],
        [{ ...projectGroup, parentPath: null }],
        []
      ]
      for (const visibleHostIds of hostFilters) {
        for (const projectGroups of groupStates) {
          for (const hiddenOtherDevicePairings of [null, new Map<string, string>()]) {
            expect(
              getUnreadBadgeCount({
                ...sources,
                visibleHostIds,
                projectGroups,
                hiddenOtherDevicePairings
              }),
              `combination ${bits}`
            ).toBeLessThanOrEqual(baselineCount(sources))
          }
        }
      }
    }
  })

  it('preserves legitimate folder terminal alerts, dedupes siblings, and clears with the workspace', () => {
    const sources = {
      ...visibility,
      worktreesByRepo: {},
      folderWorkspaces: [makeFolderWorkspace({ id: 'folder', isUnread: true })],
      tabsByWorktree: {
        'folder:folder': ['one', 'two'].map((id) => makeTab({ id, worktreeId: 'folder:folder' }))
      },
      unreadTerminalTabs: { one: 'terminal-bell', two: 'terminal-bell' }
    } satisfies UnreadBadgeCountSources
    expect(getUnreadBadgeCount(sources)).toBe(baselineCount(sources))
    expect(getUnreadBadgeCount(sources)).toBe(1)
    expect(
      getUnreadBadgeCount({
        ...sources,
        folderWorkspaces: [makeFolderWorkspace({ id: 'folder', isUnread: false })]
      })
    ).toBe(0)
  })
})
