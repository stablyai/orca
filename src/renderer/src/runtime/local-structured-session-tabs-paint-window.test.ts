// @vitest-environment happy-dom

// The window between first paint and the host's chat-tab inventory (F15a). The session writer may
// save in it, so the saved chat tabs must still be exactly where the user left them, and must stay
// there once the inventory lands. The fake host always answers `subscribeAll` at once with a
// snapshot that lacks both chats, as a host answering before its tab publication would.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import { buildPersistedUnifiedTabSessionData } from '../lib/workspace-session-unified-tabs'
import { useAppStore } from '../store'
import {
  resetLocalStructuredSessionVersionForTests,
  startLocalStructuredSessionTabsSync
} from './local-structured-session-tabs-sync'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync'

const WORKTREE_ID = 'repo-1::worktree-1'
const LEFT = 'left-group'
const RIGHT = 'right-group'
const EPOCH = 'structured:epoch-1'

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

function tab(id: string, entityId: string, groupId: string, sortOrder: number): Tab {
  const chat = id.startsWith('structured-agent-session-')
  return {
    id,
    entityId,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: chat ? 'agent-session' : 'terminal',
    ...(chat ? { agentSessionAgent: 'codex' as const } : {}),
    label: chat ? 'Codex Chat' : 'Terminal',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

/** The saved session as hydrated: a terminal and one chat on the left, a chat on the right. */
function hydrateSavedSession(): void {
  const tabs = [
    tab('terminal-1', 'terminal-1', LEFT, 0),
    tab('structured-agent-session-chat-left', 'chat-left', LEFT, 1),
    tab('structured-agent-session-chat-right', 'chat-right', RIGHT, 2)
  ]
  useAppStore.setState({
    activeWorktreeId: WORKTREE_ID,
    unifiedTabsByWorktree: { [WORKTREE_ID]: tabs },
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: LEFT,
          worktreeId: WORKTREE_ID,
          activeTabId: 'terminal-1',
          tabOrder: ['terminal-1', 'structured-agent-session-chat-left']
        },
        {
          id: RIGHT,
          worktreeId: WORKTREE_ID,
          activeTabId: 'structured-agent-session-chat-right',
          tabOrder: ['structured-agent-session-chat-right']
        }
      ]
    },
    layoutByWorktree: {
      [WORKTREE_ID]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: LEFT },
        second: { type: 'leaf', groupId: RIGHT }
      }
    },
    activeGroupIdByWorktree: { [WORKTREE_ID]: RIGHT }
  })
}

/** The tab layout the session writer would persist right now: which tabs, in which group and
 *  order, the split, and the active group. Field normalization an apply adds is not layout. */
function persisted() {
  const data = buildPersistedUnifiedTabSessionData(useAppStore.getState())
  return {
    tabs: data.unifiedTabs?.[WORKTREE_ID]?.map(({ id, entityId, groupId, contentType }) => ({
      id,
      entityId,
      groupId,
      contentType
    })),
    groups: data.tabGroups?.[WORKTREE_ID]?.map(({ id, activeTabId, tabOrder }) => ({
      id,
      activeTabId,
      tabOrder
    })),
    layout: data.tabGroupLayouts?.[WORKTREE_ID],
    activeGroup: data.activeGroupIdByWorktree?.[WORKTREE_ID]
  }
}

function hostSnapshot(version: number, sessionIds: string[]): RuntimeMobileSessionTabsResult {
  const ids = sessionIds.map((sessionId) => `agent-session:${sessionId}`)
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: EPOCH,
    snapshotVersion: version,
    activeGroupId: 'host-group',
    activeTabId: ids[0] ?? null,
    activeTabType: ids.length > 0 ? 'agent-session' : null,
    tabGroups: [{ id: 'host-group', activeTabId: ids[0] ?? null, tabOrder: ids }],
    tabs: sessionIds.map((sessionId, index) => ({
      type: 'agent-session' as const,
      id: ids[index]!,
      title: 'Codex Chat',
      sessionId,
      agent: 'codex' as const,
      isActive: index === 0
    }))
  }
}

describe('chat tabs between first paint and the host inventory', () => {
  it('saves the hydrated chat tabs unchanged before and after the inventory lands', async () => {
    hydrateSavedSession()
    const saved = persisted()
    const inventory = Promise.withResolvers<unknown>()
    const priorApi = window.api
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          getStatus: vi.fn().mockResolvedValue({
            capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
          }),
          call: vi.fn(() => inventory.promise),
          subscribe: vi.fn(async (_args: unknown, callback: (response: unknown) => void) => {
            callback({
              ok: true,
              result: { type: 'snapshots', snapshots: [hostSnapshot(1, [])] }
            })
            return { unsubscribe: vi.fn() }
          })
        }
      }
    })
    let unsubscribe = (): void => {}
    try {
      const sync = startLocalStructuredSessionTabsSync({
        isDisposed: () => false,
        setUnsubscribe: (next) => {
          unsubscribe = next
        }
      })
      for (let turn = 0; turn < 20; turn += 1) {
        await Promise.resolve()
      }
      expect(persisted()).toEqual(saved)

      inventory.resolve({
        ok: true,
        result: { snapshots: [hostSnapshot(2, ['chat-left', 'chat-right'])] }
      })
      await sync

      expect(persisted()).toEqual(saved)
    } finally {
      unsubscribe()
      Object.defineProperty(window, 'api', { configurable: true, value: priorApi })
    }
  })
})
