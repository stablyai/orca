// STA-7370: the host now relays an idle pane's conversation identity to phones only. A paired
// desktop still receives the statusless frame main sends (byte equality is asserted where the
// host projects it), so its completion, unread, duration and notification facts must not move.
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

function frame(
  snapshotVersion: number,
  agentStatus?: AgentStatusEntry
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: statuslessTab.id,
    activeTabType: 'terminal',
    tabs: [{ ...statuslessTab, ...(agentStatus ? { agentStatus } : {}) }]
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
function runDesktop(testCase: Case, nextFrame: RuntimeMobileSessionTabsResult): unknown {
  resetDesktop()
  vi.setSystemTime(NOW)
  apply(frame(1, genuineDone(testCase.interrupted)), false)
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
    // The patched host's runtime frame for this pane is the statusless frame main sends.
    const patchedHostFrame = frame(2)
    const mainFrame: RuntimeMobileSessionTabsResult = { ...frame(2), tabs: [statuslessTab] }

    const patched = runDesktop(testCase, patchedHostFrame)
    const baseline = runDesktop(testCase, mainFrame)

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
})
