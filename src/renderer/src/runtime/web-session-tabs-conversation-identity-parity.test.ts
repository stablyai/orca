// STA-7370: the host now publishes an idle pane's conversation as its own field (and an offer on
// a statusless tab). A paired desktop mirrors that field beside status, never into it, so its
// completion, unread, duration and notification facts must match a frame without the field.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { agentEntryCompletionAt } from '../../../shared/agent-completion-time'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

const mocks = vi.hoisted(() => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: mocks.observeAgentHookCompletionForNotification
}))

import { useAppStore } from '@/store'
import { countActivityUnread } from '@/components/activity/useActivityUnreadCount'
import { lastEnteredDoneAt } from '@/components/dashboard/agent-finished-timestamp'
import { nativeChatHookLatestTurnWorkedSeconds } from '@/components/native-chat/native-chat-terminal-turn'
import { resetAgentCompletionCoordinatorIdentitiesForTest } from '@/components/terminal-pane/agent-completion-coordinator'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '@/components/terminal-pane/renderer-owned-agent-status-registry'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch,
  decideWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'

const ENVIRONMENT_ID = 'web-env-1'
// Why a real host worktree id: the desktop scopes a host-mirrored row by it.
const WORKTREE_ID = 'repo::/worktree'
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const NOW = 1_700_000_000_000
const PANE_KEY = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
const initialState = useAppStore.getInitialState()

const statuslessTab: RuntimeMobileSessionTerminalClientTab = {
  type: 'terminal',
  id: `${HOST_TAB_ID}::${LEAF_ID}`,
  title: 'Say hi | my-repo',
  parentTabId: HOST_TAB_ID,
  leafId: LEAF_ID,
  isActive: true,
  status: 'ready',
  terminal: 'terminal-1',
  launchAgent: 'codex'
}

const conversationIdentity = {
  agentType: 'codex',
  providerSession: { key: 'session_id' as const, id: 'codex-session' },
  capturedAt: NOW - 1_000,
  source: 'live'
}

function frame(
  snapshotVersion: number,
  agentStatus?: AgentStatusEntry,
  withField = true
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: statuslessTab.id,
    activeTabType: 'terminal',
    tabs: [
      {
        ...statuslessTab,
        ...(agentStatus ? { agentStatus } : {}),
        ...(withField
          ? {
              conversationIdentity,
              ...(agentStatus ? {} : { conversationOfferedWithoutStatus: true as const })
            }
          : {})
      }
    ]
  }
}

function genuineDone(interrupted: boolean): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'Say hi',
    updatedAt: NOW,
    stateStartedAt: NOW,
    turnStartedAt: NOW - 6_000,
    agentType: 'codex',
    paneKey: makePaneKey(HOST_TAB_ID, LEAF_ID),
    tabId: HOST_TAB_ID,
    worktreeId: WORKTREE_ID,
    stateHistory: [{ state: 'working', prompt: 'Say hi', startedAt: NOW - 6_000 }],
    providerSession: { key: 'session_id', id: 'codex-session' },
    lastAssistantMessage: 'Hi there',
    ...(interrupted ? { interrupted: true } : {})
  }
}

function apply(snapshot: RuntimeMobileSessionTabsResult, live: boolean): void {
  // Why the round trip: a paired desktop only ever sees the frame's JSON.
  const wire: RuntimeMobileSessionTabsResult = JSON.parse(JSON.stringify(snapshot))
  applyWebSessionTabsStorePatch(
    (state) => applyWebSessionTabsSnapshot(state, wire, ENVIRONMENT_ID, Date.now()),
    {
      frames: [
        {
          environmentId: ENVIRONMENT_ID,
          worktreeId: wire.worktree,
          decision: decideWebSessionTabsSnapshot(wire, ENVIRONMENT_ID)
        }
      ]
    },
    wire,
    live
  )
}

function resetDesktop(): void {
  useAppStore.setState(initialState, true)
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetRendererOwnedAgentStatusPanesForTests()
  resetAgentCompletionCoordinatorIdentitiesForTest()
  mocks.observeAgentHookCompletionForNotification.mockReset()
}

type Case = { name: string; interrupted: boolean; clientOwned: boolean }

/** Genuine done, then the next frame the host sends for the idle pane; returns what the desktop shows. */
function runDesktop(
  testCase: Case,
  nextFrame: RuntimeMobileSessionTabsResult,
  withField = true
): unknown {
  resetDesktop()
  vi.setSystemTime(NOW)
  apply(frame(1, genuineDone(testCase.interrupted), withField), false)
  if (testCase.clientOwned) {
    registerRendererOwnedAgentStatusPane(PANE_KEY, ENVIRONMENT_ID)
    markRendererOwnedAgentStatusWrite(PANE_KEY)
    vi.advanceTimersByTime(31 * 60_000)
  }
  apply(nextFrame, true)
  const state = useAppStore.getState()
  const entry = state.agentStatusByPaneKey[PANE_KEY]
  return {
    entry,
    unread: countActivityUnread(state, NOW),
    workedSeconds: entry ? nativeChatHookLatestTurnWorkedSeconds(entry, false) : null,
    finishedAt: entry ? lastEnteredDoneAt({ rowSource: 'live', entry, state: 'done' }) : null,
    completedAt: entry ? agentEntryCompletionAt(entry) : null,
    notifications: mocks.observeAgentHookCompletionForNotification.mock.calls
  }
}

describe('paired desktop parity for the idle conversation identity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetDesktop()
    vi.useRealTimers()
  })

  const cases: Case[] = [
    { name: 'an ordinary genuine done', interrupted: false, clientOwned: false },
    { name: 'an interrupted done', interrupted: true, clientOwned: false },
    { name: 'a client-owned interrupted done 31 min later', interrupted: true, clientOwned: true }
  ]

  it.each(cases)('ends exactly as main does after $name', (testCase) => {
    // The new host's frames carry the field (and the offer when statusless); main's do not.
    const patched = runDesktop(testCase, frame(2))
    const baseline = runDesktop(testCase, frame(2, undefined, false), false)

    expect(patched).toEqual(baseline)
  })

  it('keeps a client-owned row whole, even after its freshness window', () => {
    const testCase = cases[2]
    if (!testCase) {
      throw new Error('expected the client-owned case')
    }
    resetDesktop()
    vi.setSystemTime(NOW)
    apply(frame(1, genuineDone(true)), false)
    const before = useAppStore.getState().agentStatusByPaneKey[PANE_KEY]
    expect(before?.interrupted).toBe(true)

    expect(runDesktop(testCase, frame(2))).toMatchObject({
      entry: before,
      unread: 1,
      workedSeconds: 6
    })
  })

  it('keeps tab references on an identical frame and applies an identity-only change', () => {
    resetDesktop()
    vi.setSystemTime(NOW)
    apply(frame(1), false)
    const mirrored = () =>
      useAppStore
        .getState()
        .tabsByWorktree[WORKTREE_ID]?.find(
          (tab) => tab.id === toWebTerminalSurfaceTabId(HOST_TAB_ID)
        )
    const first = mirrored()
    expect(first?.hostConversationByLeafId?.[LEAF_ID]).toMatchObject({
      offeredWithoutStatus: true
    })
    apply(frame(2), true)
    expect(mirrored()).toBe(first)

    const moved = frame(3)
    const movedTab = moved.tabs[0]
    if (movedTab?.type === 'terminal') {
      movedTab.conversationIdentity = { ...conversationIdentity, capturedAt: NOW }
    }
    apply(moved, true)
    expect(mirrored()).not.toBe(first)
    expect(mirrored()?.hostConversationByLeafId?.[LEAF_ID]?.identity?.capturedAt).toBe(NOW)

    const unoffered = frame(4)
    const unofferedTab = unoffered.tabs[0]
    if (unofferedTab?.type === 'terminal') {
      unofferedTab.conversationIdentity = { ...conversationIdentity, capturedAt: NOW }
      delete unofferedTab.conversationOfferedWithoutStatus
    }
    apply(unoffered, true)
    expect(mirrored()?.hostConversationByLeafId?.[LEAF_ID]?.offeredWithoutStatus).toBe(false)
    expect(useAppStore.getState().agentStatusByPaneKey[PANE_KEY]).toBeUndefined()
  })
})
