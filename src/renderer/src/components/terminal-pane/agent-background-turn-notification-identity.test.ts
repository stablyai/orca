import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { resetAnnouncedAgentNotificationIdsForTest } from '@/lib/announced-agent-notification-ids'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from './agent-completion-coordinator'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'

/**
 * A Claude background turn announces its banner under the turn-complete stamp
 * while the pane's status row stays `working` on the turn's start boundary. These
 * cover the two things that identity split used to break: dismissal on
 * acknowledge, and survival across a host clock that trails the desktop.
 */

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const WORKTREE_ID = 'repo::/worktree'
const WORKING_STARTED_AT = 1_700_000_000_000
const TURN_COMPLETED_AT = 1_700_000_005_000
const SECOND_WORKING_STARTED_AT = 1_700_000_006_000
const SECOND_TURN_COMPLETED_AT = 1_700_000_008_000
const DESKTOP_WORKING_STARTED_AT = 1_700_000_030_000
const REMOTE_TURN_COMPLETED_AT = 1_700_000_005_000

const initialState = useAppStore.getInitialState()

function seedLiveClaudeWorkingRow(stateStartedAt: number): void {
  useAppStore.setState({
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: 'pty-1',
          worktreeId: WORKTREE_ID,
          title: 'Claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: stateStartedAt
        }
      ]
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    },
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        state: 'working',
        prompt: 'review the PR',
        updatedAt: stateStartedAt,
        stateStartedAt,
        agentType: 'claude',
        paneKey: PANE_KEY,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        terminalTitle: 'claude',
        stateHistory: []
      }
    },
    worktreesByRepo: {
      repo: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo', path: '/worktree' })]
    },
    repos: [{ id: 'repo', path: '/repo', displayName: 'orca', badgeColor: '#000', addedAt: 0 }],
    settings: {
      ...getDefaultSettings('/tmp'),
      experimentalTerminalAttention: true
    }
  })
}

type BackgroundTurn = { stateStartedAt: number; turnCompletedAt: number }

/**
 * Drives the real coordinator through Claude background turns. Each turn is a
 * `working` hook followed by a `working` hook carrying the turn-complete stamp —
 * the pane never leaves `working`.
 */
function announceBackgroundTurns(
  turns: readonly BackgroundTurn[]
): AgentCompletionStatusSnapshot[] {
  const announced: AgentCompletionStatusSnapshot[] = []
  const coordinator = createAgentCompletionCoordinator({
    paneKey: PANE_KEY,
    getPtyId: () => 'pty-1',
    getSettings: () => null,
    inspectProcess: vi.fn(),
    dispatchCompletion: (title, meta) => {
      if (meta?.agentStatus) {
        announced.push(meta.agentStatus)
      }
      dispatchTerminalNotification(WORKTREE_ID, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey: PANE_KEY,
        agentCompletionSource: meta?.source,
        agentStatusSnapshot: meta?.agentStatus
      })
    },
    isLive: () => true
  })

  for (const turn of turns) {
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: turn.stateStartedAt
    })
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      lastAssistantMessage: 'Which cells need hand-verification?',
      stateStartedAt: turn.stateStartedAt,
      turnCompletedAt: turn.turnCompletedAt
    })
  }
  coordinator.dispose()
  return announced
}

function dispatchMock(): ReturnType<typeof vi.fn> {
  return window.api.notifications.dispatch as unknown as ReturnType<typeof vi.fn>
}

function announcedNotificationIds(): (string | undefined)[] {
  return dispatchMock().mock.calls.map(
    (call) => (call[0] as { notificationId?: string } | undefined)?.notificationId
  )
}

function dismissedNotificationIds(): string[] {
  const dismiss = window.api.notifications.dismiss as unknown as ReturnType<typeof vi.fn>
  return (dismiss.mock.calls.at(-1)?.[0] ?? []) as string[]
}

function agentNotificationId(stateStartedAt: number): string | null {
  return buildAgentNotificationId({ worktreeId: WORKTREE_ID, paneKey: PANE_KEY, stateStartedAt })
}

describe('Claude background-turn notification identity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TURN_COMPLETED_AT)
    resetAgentCompletionCoordinatorIdentitiesForTest()
    resetAnnouncedAgentNotificationIdsForTest()
    useAppStore.setState(initialState, true)
    vi.stubGlobal('window', {
      api: {
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true }),
          dismiss: vi.fn().mockResolvedValue({ dismissed: 0 })
        }
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    resetAgentCompletionCoordinatorIdentitiesForTest()
    resetAnnouncedAgentNotificationIdsForTest()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('dismisses the announced banner id when a still-working Claude row is acknowledged', () => {
    seedLiveClaudeWorkingRow(WORKING_STARTED_AT)
    const [announcedSnapshot] = announceBackgroundTurns([
      { stateStartedAt: WORKING_STARTED_AT, turnCompletedAt: TURN_COMPLETED_AT }
    ])

    const announcedId = announcedNotificationIds().at(-1)

    expect(announcedSnapshot).toMatchObject({
      state: 'done',
      stateStartedAt: TURN_COMPLETED_AT,
      turnCompletedAt: TURN_COMPLETED_AT
    })
    expect(useAppStore.getState().agentStatusByPaneKey[PANE_KEY]?.state).toBe('working')
    expect(useAppStore.getState().agentStatusByPaneKey[PANE_KEY]?.stateStartedAt).toBe(
      WORKING_STARTED_AT
    )
    expect(announcedId).toBe(agentNotificationId(TURN_COMPLETED_AT))

    useAppStore.getState().acknowledgeAgents([PANE_KEY])

    expect(dismissedNotificationIds()).toEqual([announcedId])
  })

  it('dismisses again when native delivery settles after acknowledgement', async () => {
    let resolveDispatch!: (result: { delivered: true }) => void
    dispatchMock().mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDispatch = resolve
      })
    )
    seedLiveClaudeWorkingRow(WORKING_STARTED_AT)
    announceBackgroundTurns([
      { stateStartedAt: WORKING_STARTED_AT, turnCompletedAt: TURN_COMPLETED_AT }
    ])

    useAppStore.getState().acknowledgeAgents([PANE_KEY])
    expect(window.api.notifications.dismiss).toHaveBeenCalledTimes(1)

    resolveDispatch({ delivered: true })
    await Promise.resolve()

    expect(window.api.notifications.dismiss).toHaveBeenCalledTimes(2)
    expect(dismissedNotificationIds()).toEqual([agentNotificationId(TURN_COMPLETED_AT)])
  })

  it('replaces successive background turns on one pane and dismisses the shared id', () => {
    seedLiveClaudeWorkingRow(WORKING_STARTED_AT)
    const announcedSnapshots = announceBackgroundTurns([
      { stateStartedAt: WORKING_STARTED_AT, turnCompletedAt: TURN_COMPLETED_AT },
      { stateStartedAt: SECOND_WORKING_STARTED_AT, turnCompletedAt: SECOND_TURN_COMPLETED_AT }
    ])

    expect(announcedSnapshots.map((snapshot) => snapshot.turnCompletedAt)).toEqual([
      TURN_COMPLETED_AT,
      SECOND_TURN_COMPLETED_AT
    ])
    const ids = announcedNotificationIds()
    expect(ids).toEqual([
      agentNotificationId(TURN_COMPLETED_AT),
      agentNotificationId(TURN_COMPLETED_AT)
    ])
    expect(new Set(ids).size).toBe(1)

    useAppStore.getState().acknowledgeAgents([PANE_KEY])

    expect(dismissedNotificationIds()).toEqual([ids[0]])
  })

  it('announces a Claude background-turn completion when the remote clock trails the desktop', () => {
    seedLiveClaudeWorkingRow(DESKTOP_WORKING_STARTED_AT)

    announceBackgroundTurns([
      {
        stateStartedAt: REMOTE_TURN_COMPLETED_AT - 5_000,
        turnCompletedAt: REMOTE_TURN_COMPLETED_AT
      }
    ])

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        notificationId: agentNotificationId(REMOTE_TURN_COMPLETED_AT)
      })
    )
  })
})
