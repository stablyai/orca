// @vitest-environment happy-dom

/**
 * A chat the host starts for a source-control button lands in the group the button was used from.
 *
 * The button reserves that group before it asks the host, and the chat arrives only through the
 * session-tabs mirror, under its session tab id. The host files a new chat in the group it knows,
 * which is never the empty split the user focused, so the reservation has to reach the mirror.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { WorktreeRuntimeOwnerState } from '../lib/worktree-runtime-owner'
import { reserveAgentLaunchTab } from '../lib/agent-launch-tab-reservations'
import {
  applyLocalStructuredSessionTabSnapshots,
  resetLocalStructuredSessionVersionForTests
} from './local-structured-session-tabs-sync'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const WORKTREE = 'repo-1::/tmp/wt-launch'
const SESSION_ID = 'claude-launch-1'
const HOST_TAB_ID = `agent-session:${SESSION_ID}`
const SESSION_TAB = `structured-agent-session-${SESSION_ID}`
const releases: (() => void)[] = []

type SyncState = WebSessionTabsSyncState & WorktreeRuntimeOwnerState

afterEach(() => {
  releases.splice(0).forEach((release) => release())
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSyncTestState()
})

/** Terminal 1 in `g-1`, and an empty split `g-2` the user focused before clicking the button. */
function workspaceWithEmptyFocusedSplit(): SyncState {
  return {
    ...makeState({
      activeWorktreeId: WORKTREE,
      activeGroupIdByWorktree: { [WORKTREE]: 'g-2' },
      activeTabIdByWorktree: { [WORKTREE]: 'term-1' },
      activeTabTypeByWorktree: { [WORKTREE]: 'terminal' },
      groupsByWorktree: {
        [WORKTREE]: [
          { id: 'g-1', worktreeId: WORKTREE, activeTabId: 'term-1', tabOrder: ['term-1'] },
          { id: 'g-2', worktreeId: WORKTREE, activeTabId: null, tabOrder: [] }
        ]
      },
      layoutByWorktree: {
        [WORKTREE]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'g-1' },
          second: { type: 'leaf', groupId: 'g-2' }
        }
      },
      ptyIdsByTabId: { 'term-1': ['pty-1'] },
      tabBarOrderByWorktree: { [WORKTREE]: ['term-1'] },
      unifiedTabsByWorktree: {
        [WORKTREE]: [
          {
            id: 'term-1',
            entityId: 'term-1',
            groupId: 'g-1',
            worktreeId: WORKTREE,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }),
    worktreesByRepo: {
      'repo-1': [{ id: WORKTREE, repoId: 'repo-1' }]
    }
  }
}

/** The host's first frame for the chat, filed in the one group it knows holds tabs. */
function hostChatFrame(snapshotVersion = 1): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    [
      {
        type: 'agent-session',
        id: HOST_TAB_ID,
        title: 'Claude Chat',
        sessionId: SESSION_ID,
        agent: 'claude',
        isActive: true
      }
    ],
    {
      worktree: WORKTREE,
      publicationEpoch: 'renderer:launch-placement',
      snapshotVersion,
      activeGroupId: 'g-1',
      activeTabId: HOST_TAB_ID,
      activeTabType: 'agent-session',
      tabGroups: [{ id: 'g-1', activeTabId: HOST_TAB_ID, tabOrder: ['term-1', HOST_TAB_ID] }]
    }
  )
}

function groupOf(state: SyncState, tabId: string): string | undefined {
  return state.groupsByWorktree[WORKTREE]?.find((group) => group.tabOrder.includes(tabId))?.id
}

describe('a chat a source-control button asked the host for', () => {
  it('lands in the empty split the button was used from', () => {
    // What the button reserves: the terminal pane's tab id and the chat's session tab id.
    releases.push(
      reserveAgentLaunchTab(['pane-tab-1', HOST_TAB_ID], { worktreeId: WORKTREE, groupId: 'g-2' })
    )

    const state = applyLocalStructuredSessionTabSnapshots(workspaceWithEmptyFocusedSplit(), [
      hostChatFrame()
    ])

    expect(groupOf(state, SESSION_TAB)).toBe('g-2')
    expect(groupOf(state, 'term-1')).toBe('g-1')
  })

  it('stays where the host filed it when no launch reserved it, as before', () => {
    const state = applyLocalStructuredSessionTabSnapshots(workspaceWithEmptyFocusedSplit(), [
      hostChatFrame()
    ])

    expect(groupOf(state, SESSION_TAB)).toBe('g-1')
  })

  it('stays where the user moved it after it arrived', () => {
    releases.push(
      reserveAgentLaunchTab(['pane-tab-1', HOST_TAB_ID], { worktreeId: WORKTREE, groupId: 'g-2' })
    )
    const placed = applyLocalStructuredSessionTabSnapshots(workspaceWithEmptyFocusedSplit(), [
      hostChatFrame()
    ])
    const moved: SyncState = {
      ...placed,
      groupsByWorktree: {
        [WORKTREE]: [
          {
            id: 'g-1',
            worktreeId: WORKTREE,
            activeTabId: SESSION_TAB,
            tabOrder: ['term-1', SESSION_TAB]
          },
          { id: 'g-2', worktreeId: WORKTREE, activeTabId: null, tabOrder: [] }
        ]
      },
      unifiedTabsByWorktree: {
        [WORKTREE]: (placed.unifiedTabsByWorktree[WORKTREE] ?? []).map((tab) =>
          tab.id === SESSION_TAB ? { ...tab, groupId: 'g-1' } : tab
        )
      }
    }

    const next = applyLocalStructuredSessionTabSnapshots(moved, [hostChatFrame(2)])

    expect(groupOf(next, SESSION_TAB)).toBe('g-1')
  })
})
