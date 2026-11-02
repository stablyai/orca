// @vitest-environment happy-dom

// A chat the host publishes in its new workspace leaves the window's tabs in retired workspaces.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'

// The shipped layout owner: the window saves what it shows, so its tabs must converge.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

import { useAppStore } from '@/store'
import { applyStructuredSessionTabSnapshots } from './snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './inventory-generation-fence'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../web-session-tabs-sync/tracking-lifecycle'

const RETIRED = 'retired::/project'
const CURRENT = 'current::/project'
const OTHER = 'current::/other'

function chat(id: string, sessionId: string, worktreeId: string): Tab {
  return {
    id,
    entityId: sessionId,
    groupId: `group-${worktreeId}`,
    worktreeId,
    executionHostId: 'local',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function listing(worktree: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group',
    activeTabId: 'agent-session:moved',
    activeTabType: 'agent-session',
    tabGroups: [
      { id: 'host-group', activeTabId: 'agent-session:moved', tabOrder: ['agent-session:moved'] }
    ],
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:moved',
        title: 'Moved chat',
        sessionId: 'moved',
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const retired = [
    chat('agent-session:moved', 'moved', RETIRED),
    chat('agent-session:kept', 'kept', RETIRED)
  ]
  useAppStore.setState({
    repos: [
      { id: 'current', path: '/project', displayName: 'current', badgeColor: '#000', addedAt: 0 }
    ],
    unifiedTabsByWorktree: {
      [RETIRED]: retired,
      [OTHER]: [chat('agent-session:moved', 'moved', OTHER)]
    },
    groupsByWorktree: {
      [RETIRED]: [
        {
          id: `group-${RETIRED}`,
          worktreeId: RETIRED,
          activeTabId: 'agent-session:moved',
          tabOrder: retired.map((tab) => tab.id)
        }
      ]
    },
    tabBarOrderByWorktree: { [RETIRED]: retired.map((tab) => tab.id) }
  })
})

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

it('drops only the retired copy when the host first places the chat elsewhere', () => {
  applyStructuredSessionTabSnapshots([listing(CURRENT)])

  const state = useAppStore.getState()
  expect(state.unifiedTabsByWorktree[CURRENT]?.map((tab) => tab.entityId)).toEqual(['moved'])
  expect(state.unifiedTabsByWorktree[RETIRED]?.map((tab) => tab.entityId)).toEqual(['kept'])
  expect(state.groupsByWorktree[RETIRED]?.[0]).toMatchObject({
    tabOrder: ['agent-session:kept'],
    activeTabId: 'agent-session:kept'
  })
  expect(state.tabBarOrderByWorktree[RETIRED]).toEqual(['agent-session:kept'])
  // A registered workspace's copy is not this listing's to judge.
  expect(state.unifiedTabsByWorktree[OTHER]?.map((tab) => tab.entityId)).toEqual(['moved'])
})
