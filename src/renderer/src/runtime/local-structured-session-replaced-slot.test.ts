// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import type { WorktreeRuntimeOwnerState } from '../lib/worktree-runtime-owner-state'
import { applyLocalStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import { makeState } from './web-session-tabs-sync-test-harness'

// The window's half of a terminal→chat switch: the host's frame carries the chat with the slot it
// replaced, and the window puts the chat there and reports the terminal tab for closing.

const WORKTREE = 'repo-1::/tmp/wt-switch'
const GROUP = 'group-1'

type SyncState = WebSessionTabsSyncState & WorktreeRuntimeOwnerState

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

const terminalTab = (id: string): Tab => ({
  id,
  entityId: id,
  groupId: GROUP,
  worktreeId: WORKTREE,
  contentType: 'terminal',
  label: id,
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
})

it('puts the chat in the replaced terminal’s slot and reports that terminal', () => {
  const state = {
    ...makeState({ activeWorktreeId: WORKTREE }),
    unifiedTabsByWorktree: {
      [WORKTREE]: [terminalTab('before'), terminalTab('switched'), terminalTab('after')]
    },
    groupsByWorktree: {
      [WORKTREE]: [
        {
          id: GROUP,
          worktreeId: WORKTREE,
          activeTabId: 'switched',
          tabOrder: ['before', 'switched', 'after'],
          recentTabIds: ['switched']
        }
      ]
    },
    worktreesByRepo: { 'repo-1': [{ id: WORKTREE, path: '/tmp/wt-switch' }] }
  } as unknown as SyncState
  const frame = {
    worktree: WORKTREE,
    publicationEpoch: 'renderer:switch',
    snapshotVersion: 1,
    activeGroupId: GROUP,
    activeTabId: 'agent-session:session-1',
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:session-1',
        title: 'Codex',
        sessionId: 'session-1',
        agent: 'codex',
        isActive: true,
        replaces: { tabId: 'switched' }
      }
    ],
    tabGroups: [{ id: GROUP, activeTabId: null, tabOrder: ['agent-session:session-1'] }]
  } as unknown as RuntimeMobileSessionTabsResult
  const onReplacedTab = vi.fn()
  const next = applyLocalStructuredSessionTabSnapshots(state, [frame], undefined, 1, {
    onReplacedTab
  })
  const chat = next.unifiedTabsByWorktree[WORKTREE]?.find(
    (tab) => tab.contentType === 'agent-session'
  )
  expect(next.groupsByWorktree[WORKTREE]?.[0]?.tabOrder).toEqual([
    'before',
    chat?.id,
    'switched',
    'after'
  ])
  expect(onReplacedTab).toHaveBeenCalledExactlyOnceWith({
    worktreeId: WORKTREE,
    tabId: 'switched',
    sessionId: 'session-1'
  })
})
