// @vitest-environment happy-dom

import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { worktree as baseWorktree } from '@/components/sidebar/worktree-list-groups-test-fixtures'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import type { Tab } from '../../../shared/tab-types'
import { createUnreadBadgeCountSelector } from './unread-badge-count-selector'

const initialState = useAppStore.getInitialState()
afterEach(() => useAppStore.setState(initialState, true))

function seedUnreadChild(): Tab {
  const tab: Tab = {
    id: 'child-tab',
    entityId: 'child-tab',
    groupId: 'group',
    worktreeId: 'child',
    executionHostId: 'local',
    contentType: 'terminal',
    label: 'Child',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  useAppStore.setState(
    {
      ...initialState,
      settings: createGlobalSettingsFixture({
        notifications: { ...getDefaultNotificationSettings(), showChildWorktreeUnread: false }
      }),
      worktreesByRepo: {
        repo: ['parent', 'child'].map((id) => ({
          ...baseWorktree,
          id,
          instanceId: id,
          hostId: 'local' as const,
          isUnread: false
        }))
      },
      worktreeLineageById: {
        child: {
          worktreeId: 'child',
          worktreeInstanceId: 'child',
          parentWorktreeId: 'parent',
          parentWorktreeInstanceId: 'parent',
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: 1
        }
      },
      tabsByWorktree: {
        child: [
          {
            id: tab.id,
            worktreeId: 'child',
            ptyId: null,
            title: 'Child',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      unifiedTabsByWorktree: { child: [tab] },
      unreadTerminalTabs: { [tab.id]: true }
    },
    true
  )
  return tab
}

it('filters terminal-only child unread through the actual store and restores it on toggle', () => {
  seedUnreadChild()
  const select = createUnreadBadgeCountSelector()
  expect(select(useAppStore.getState())).toBe(0)
  useAppStore.setState({ settings: createGlobalSettingsFixture() })
  expect(select(useAppStore.getState())).toBe(1)
})

it('recounts when the actual store hydrates ownership before a same-id remote row', () => {
  const tab = seedUnreadChild()
  const select = createUnreadBadgeCountSelector()
  expect(select(useAppStore.getState())).toBe(0)
  useAppStore.setState({
    unifiedTabsByWorktree: {
      child: [{ ...tab, executionHostId: 'ssh:remote' }]
    }
  })
  expect(select(useAppStore.getState())).toBe(1)
})
