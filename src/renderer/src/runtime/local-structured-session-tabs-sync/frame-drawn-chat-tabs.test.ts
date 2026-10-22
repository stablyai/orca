// @vitest-environment happy-dom

// Switch-on, this machine's chat listing leaves a frame-drawn workspace's tabs as main drew them
// and only updates a drawn chat tab's label from the host's title.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { applyStructuredSessionTabSnapshots } from './snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './inventory-generation-fence'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../web-session-tabs-sync/tracking-lifecycle'

const WT = 'repo-1::wt-drawn'
const GROUP = 'group-1'
const TERMINAL = 'terminal-1'
const CHAT = 'structured-agent-session-chat-1'

function tab(id: string, entityId: string, contentType: Tab['contentType'], label: string): Tab {
  return {
    id,
    entityId,
    groupId: GROUP,
    worktreeId: WT,
    contentType,
    label,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

const STRUCTURE_FIELDS = [
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree',
  'tabBarOrderByWorktree',
  'activeTabIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabId',
  'activeTabType'
] as const

function structure(state: AppState): Partial<AppState> {
  return Object.fromEntries(STRUCTURE_FIELDS.map((field) => [field, state[field]]))
}

/** The host lists the drawn chat under a new title and a second chat main has not placed yet. */
function listing(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group',
    activeTabId: 'agent-session:chat-2',
    activeTabType: 'agent-session',
    navigationIntent: 'follow',
    tabGroups: [
      {
        id: 'host-group',
        activeTabId: 'agent-session:chat-2',
        tabOrder: ['agent-session:chat-1', 'agent-session:chat-2']
      }
    ],
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:chat-1',
        title: 'Renamed by host',
        sessionId: 'chat-1',
        agent: 'codex',
        isActive: false
      },
      {
        type: 'agent-session',
        id: 'agent-session:chat-2',
        title: 'Second chat',
        sessionId: 'chat-2',
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: WT,
    unifiedTabsByWorktree: {
      [WT]: [
        tab(TERMINAL, TERMINAL, 'terminal', 'Terminal'),
        { ...tab(CHAT, 'chat-1', 'agent-session', 'Old title'), agentSessionAgent: 'codex' }
      ]
    },
    groupsByWorktree: {
      [WT]: [{ id: GROUP, worktreeId: WT, activeTabId: TERMINAL, tabOrder: [TERMINAL, CHAT] }]
    },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: GROUP } },
    activeGroupIdByWorktree: { [WT]: GROUP },
    tabBarOrderByWorktree: { [WT]: [TERMINAL, CHAT] },
    activeTabIdByWorktree: { [WT]: TERMINAL },
    activeTabTypeByWorktree: { [WT]: 'terminal' },
    activeTabId: TERMINAL,
    activeTabType: 'terminal'
  })
})

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

describe('chat listing for a frame-drawn workspace', () => {
  it('keeps the tabs main drew and takes the host title as the drawn chat label', () => {
    const drawn = structure(useAppStore.getState())

    applyStructuredSessionTabSnapshots([listing()])

    const after = useAppStore.getState()
    expect(after.unifiedTabsByWorktree[WT]?.find((t) => t.id === CHAT)?.label).toBe(
      'Renamed by host'
    )
    const relabelled = {
      ...drawn,
      unifiedTabsByWorktree: {
        [WT]: (drawn.unifiedTabsByWorktree?.[WT] ?? []).map((t) =>
          t.id === CHAT ? { ...t, label: 'Renamed by host' } : t
        )
      }
    }
    expect(structure(after)).toEqual(relabelled)
  })
})
