import { getDefaultSettings } from '../../../../../shared/constants'
import type {
  observeAgentHookCompletionForNotification,
  resetAgentHookCompletionNotificationCoordinators
} from '@/hooks/agent-hook-completion-notifications'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusChange } from '@/store/slices/agent-status/agent-status-contract'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'

const mocks = vi.hoisted(() => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: mocks.observeAgentHookCompletionForNotification
}))

import { useAppStore } from '@/store/index'
import { createAgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion/agent-completion-coordinator'
import { resetAgentCompletionCoordinatorIdentitiesForTest } from '@/components/terminal-pane/agent-completion/agent-completion-identity-store'
import { dispatchTerminalNotification } from '../../../components/terminal-pane/notifications/dispatch-terminal-notification'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '@/components/terminal-pane/agent-status/renderer-owned-agent-status-registry'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  applyWebSessionTabsSnapshotOperations
} from '../snapshot-api'
import { applyWebSessionTabsStorePatch } from '../store-patch'
import { decideWebSessionTabsSnapshot } from '../tracking-decisions'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../tracking-lifecycle'

const ENVIRONMENT_ID = 'web-env-1'
const WORKTREE_ID = 'repo::/worktree'
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const NOW = 1_700_000_000_000
const initialState = useAppStore.getInitialState()

function makeAgentSnapshot(
  snapshotVersion: number,
  updatedAt: number,
  turnCompletedAt?: number,
  state: 'working' | 'done' = 'working',
  stateStartedAt = NOW
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: HOST_TAB_ID,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${HOST_TAB_ID}::${LEAF_ID}`,
        title: 'Claude working',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {}),
        agentStatus: {
          state,
          prompt: 'review the PR',
          updatedAt,
          stateStartedAt,
          agentType: 'claude',
          paneKey: makePaneKey(HOST_TAB_ID, LEAF_ID),
          tabId: HOST_TAB_ID,
          worktreeId: WORKTREE_ID,
          stateHistory: []
        }
      }
    ]
  }
}

/** An older host omits the worktree on agents restored after a restart. */
function withoutAgentWorktree(
  snapshot: RuntimeMobileSessionTabsResult
): RuntimeMobileSessionTabsResult {
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => {
      if (tab.type !== 'terminal' || !tab.agentStatus) {
        return tab
      }
      const { worktreeId: _worktreeId, ...agentStatus } = tab.agentStatus
      return { ...tab, agentStatus }
    })
  }
}

function applySnapshot(
  snapshot: RuntimeMobileSessionTabsResult,
  live: boolean,
  unbound = false
): void {
  const decision = decideWebSessionTabsSnapshot(snapshot, ENVIRONMENT_ID)
  applyWebSessionTabsStorePatch(
    (state, changedAgentPaneKeys) => {
      const patch = applyWebSessionTabsSnapshot(
        state,
        snapshot,
        ENVIRONMENT_ID,
        NOW,
        undefined,
        changedAgentPaneKeys
      )
      if (!unbound) {
        return patch
      }
      const tabId = toWebTerminalSurfaceTabId(HOST_TAB_ID)
      return {
        ...patch,
        tabsByWorktree: {
          ...(patch.tabsByWorktree ?? state.tabsByWorktree),
          [WORKTREE_ID]: (
            patch.tabsByWorktree?.[WORKTREE_ID] ??
            state.tabsByWorktree[WORKTREE_ID] ??
            []
          ).map((tab) => ({ ...tab, ptyId: null }))
        },
        ptyIdsByTabId: { ...(patch.ptyIdsByTabId ?? state.ptyIdsByTabId), [tabId]: [] },
        terminalLayoutsByTabId: {
          ...(patch.terminalLayoutsByTabId ?? state.terminalLayoutsByTabId),
          [tabId]: {
            root: { type: 'leaf' as const, leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        }
      }
    },
    { frames: [{ environmentId: ENVIRONMENT_ID, worktreeId: snapshot.worktree, decision }] },
    snapshot,
    live
  )
}

describe('paired session-tab agent completion notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.observeAgentHookCompletionForNotification.mockReset()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.each([
    'missed',
    'first-live',
    'first-live-aged',
    'cold',
    'seen',
    'read',
    'successor'
  ] as const)(
    'delivers only unseen canonical history through the real paired observer (%s)',
    async (mode) => {
      const actual = await vi.importActual<{
        observeAgentHookCompletionForNotification: typeof observeAgentHookCompletionForNotification
        resetAgentHookCompletionNotificationCoordinators: typeof resetAgentHookCompletionNotificationCoordinators
      }>('@/hooks/agent-hook-completion-notifications')
      const { setPresenceGated } = await import('@/hooks/agent-auto-ack-presence')
      const { TEST_REPO } = await import('@/store/repos/repo.test-fixture')
      const { makeWorktree } = await import('@/store/slices/worktrees/worktree.test-fixture')
      vi.setSystemTime(NOW + (mode === 'first-live-aged' ? 60_000 : 300))
      const dispatch = vi.fn(async () => ({ delivered: true }))
      vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
      vi.stubGlobal('window', {
        api: {
          notifications: { dispatch },
          github: { enqueuePRRefresh: vi.fn(async () => undefined) },
          agentStatus: {}
        }
      })
      useAppStore.setState({
        settings: {
          ...getDefaultSettings('/tmp/delete-retention-fixture'),
          experimentalTerminalAttention: true
        },
        repos: [{ ...TEST_REPO, id: 'repo', executionHostId: 'runtime:web-env-1' }],
        worktreesByRepo: {
          repo: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo', hostId: 'runtime:web-env-1' })]
        },
        activeWorktreeId: null,
        refreshGitHubForWorktreeIfStale: vi.fn()
      })
      const markUnread = vi.fn(useAppStore.getState().markAgentAttentionUnread)
      useAppStore.setState({ markAgentAttentionUnread: markUnread })
      setPresenceGated(false)
      actual.resetAgentHookCompletionNotificationCoordinators()
      mocks.observeAgentHookCompletionForNotification.mockImplementation(
        actual.observeAgentHookCompletionForNotification
      )
      const paneKey = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
      const end = {
        state: 'done' as const,
        prompt: 'first task',
        startedAt: NOW + 100,
        turnEndedAt: NOW + 110,
        turnEndDisposition: 'identified' as const
      }
      const snapshot = (version: number, sleeping: boolean) => {
        const next = makeAgentSnapshot(
          version,
          NOW + version * 100,
          undefined,
          sleeping ? 'done' : 'working',
          NOW + 200
        )
        const surface = next.tabs[0]
        if (surface.type !== 'terminal' || !surface.agentStatus) {
          throw new Error('Missing fixture status')
        }
        surface.agentStatus.prompt = 'second task'
        if (sleeping) {
          surface.agentStatus.sessionBoundary = true
        }
        if (sleeping || mode === 'seen') {
          surface.agentStatus.stateHistory = [end]
        }
        surface.agentStatus.lastCompletedAssistantMessage = 'First task finished.'
        return next
      }
      try {
        if (mode !== 'cold' && mode !== 'first-live' && mode !== 'first-live-aged') {
          applySnapshot(snapshot(1, false), true, true)
        }
        if (mode === 'read') {
          useAppStore.setState({ acknowledgedAgentsByPaneKey: { [paneKey]: NOW + 100 } })
        }
        applySnapshot(snapshot(2, true), mode !== 'cold', true)
        if (mode === 'successor') {
          applySnapshot(makeAgentSnapshot(3, NOW + 400, undefined, 'working', NOW + 400), true)
        }
        await vi.advanceTimersByTimeAsync(2_000)
        const delivers = mode === 'missed' || mode === 'first-live' || mode === 'first-live-aged'
        expect(dispatch).toHaveBeenCalledTimes(delivers ? 1 : 0)
        if (delivers) {
          expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
              agentPrompt: 'first task',
              agentLastAssistantMessage: 'First task finished.',
              notificationId: expect.stringContaining(String(NOW + 100))
            })
          )
        }
        expect({
          marked: markUnread.mock.calls.length,
          pane: Boolean(useAppStore.getState().unreadAgentCompletionPanes[paneKey]),
          workspace: useAppStore.getState().worktreesByRepo.repo?.[0]?.isUnread
        }).toEqual({
          marked: delivers ? 1 : 0,
          pane: delivers,
          workspace: delivers
        })
      } finally {
        actual.resetAgentHookCompletionNotificationCoordinators()
        setPresenceGated(true)
        mocks.observeAgentHookCompletionForNotification.mockReset()
      }
    }
  )

  it.each(['warm', 'cold-replay', 'first-live'] as const)(
    'publishes passive sleeping Done without completion news (%s)',
    (mode) => {
      if (mode === 'warm') {
        applySnapshot(makeAgentSnapshot(1, NOW), true)
      }
      const asleep = makeAgentSnapshot(mode === 'warm' ? 2 : 1, NOW + 100, undefined, 'done')
      const surface = asleep.tabs[0]
      if (surface.type !== 'terminal' || !surface.agentStatus) {
        throw new Error('Expected terminal status')
      }
      surface.agentStatus.sessionBoundary = true
      mocks.observeAgentHookCompletionForNotification.mockClear()
      applySnapshot(asleep, mode !== 'cold-replay')
      expect(mocks.observeAgentHookCompletionForNotification).not.toHaveBeenCalled()
      const key = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
      expect(useAppStore.getState().agentStatusByPaneKey[key]?.sessionBoundary).toBe(true)
    }
  )

  it('does not reannounce an unread earlier finish when the next working turn sleeps', () => {
    const end = {
      state: 'done' as const,
      prompt: 'first task',
      startedAt: NOW,
      turnEndedAt: NOW + 10,
      turnEndDisposition: 'identified' as const
    }
    applySnapshot(makeAgentSnapshot(1, NOW, undefined, 'working'), true)
    applySnapshot(makeAgentSnapshot(2, NOW + 10, undefined, 'done', NOW), true)
    const working = makeAgentSnapshot(3, NOW + 20, undefined, 'working', NOW + 20)
    const current = working.tabs[0]
    if (current.type !== 'terminal' || !current.agentStatus) {
      throw new Error('Expected terminal status')
    }
    current.agentStatus.stateHistory = [end]
    applySnapshot(working, true)
    const asleep = makeAgentSnapshot(4, NOW + 30, undefined, 'done', NOW + 20)
    const sleeping = asleep.tabs[0]
    if (sleeping.type !== 'terminal' || !sleeping.agentStatus) {
      throw new Error('Expected terminal status')
    }
    sleeping.agentStatus.sessionBoundary = true
    sleeping.agentStatus.stateHistory = [end]
    mocks.observeAgentHookCompletionForNotification.mockClear()
    applySnapshot(asleep, true)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        seedOnly: true,
        payload: expect.objectContaining({
          state: 'done',
          stateStartedAt: NOW,
          prompt: 'first task'
        })
      })
    )
  })

  it('does not equate passive Done with a genuine completion having the same clocks', () => {
    const asleep = makeAgentSnapshot(1, NOW, undefined, 'done')
    const surface = asleep.tabs[0]
    if (surface.type !== 'terminal' || !surface.agentStatus) {
      throw new Error('Expected terminal status')
    }
    surface.agentStatus.sessionBoundary = true
    applySnapshot(asleep, true)
    mocks.observeAgentHookCompletionForNotification.mockClear()
    applySnapshot(makeAgentSnapshot(2, NOW, undefined, 'done'), false)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ state: 'done' }) })
    )
    const key = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
    expect(useAppStore.getState().agentStatusByPaneKey[key]?.sessionBoundary).not.toBe(true)
  })

  it.each(['single', 'batch', 'operations'] as const)(
    'reports committed mirror keys through %s reconciliation and retraction',
    (kind) => {
      const observed = vi.fn((changes: readonly AgentStatusChange[]) => {
        for (const change of changes) {
          expect(useAppStore.getState().agentStatusByPaneKey[change.paneKey]).toBe(change.current)
        }
      })
      const dispose = useAppStore.getState().subscribeAgentStatusChanges(observed)
      const paneKey = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
      const apply = (snapshot: RuntimeMobileSessionTabsResult) => {
        const decision = decideWebSessionTabsSnapshot(snapshot, ENVIRONMENT_ID)
        const settle = applyWebSessionTabsStorePatch(
          (state, keys) => {
            if (kind === 'batch') {
              return applyWebSessionTabsSnapshots(state, [snapshot], ENVIRONMENT_ID, NOW, keys)
            }
            if (kind === 'operations') {
              return applyWebSessionTabsSnapshotOperations(
                state,
                [{ snapshot, environmentId: ENVIRONMENT_ID, decision }],
                keys
              )
            }
            return applyWebSessionTabsSnapshot(
              state,
              snapshot,
              ENVIRONMENT_ID,
              NOW,
              undefined,
              keys
            )
          },
          { frames: [{ environmentId: ENVIRONMENT_ID, worktreeId: WORKTREE_ID, decision }] }
        )
        settle()
      }
      try {
        apply(makeAgentSnapshot(1, NOW))
        expect(observed).toHaveBeenCalledExactlyOnceWith([
          {
            paneKey,
            previous: undefined,
            current: useAppStore.getState().agentStatusByPaneKey[paneKey]
          }
        ])
        const previous = useAppStore.getState().agentStatusByPaneKey[paneKey]
        observed.mockClear()
        apply({ ...makeAgentSnapshot(2, NOW + 1), tabs: [] })
        expect(observed).toHaveBeenCalledExactlyOnceWith([
          { paneKey, previous, current: undefined }
        ])
        observed.mockClear()
        apply({ ...makeAgentSnapshot(3, NOW + 2), tabs: [] })
        expect(observed).not.toHaveBeenCalled()
      } finally {
        dispose()
      }
    }
  )

  it.each([
    ['a host naming the worktree', (snapshot: RuntimeMobileSessionTabsResult) => snapshot],
    ['an older host that omits it', withoutAgentWorktree]
  ])(
    'announces one live stamped completion after a late-pair working seed from %s',
    (_label, frame) => {
      const dispatchCompletion = vi.fn()
      const coordinator = createAgentCompletionCoordinator({
        paneKey: makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID),
        getPtyId: () => 'pty-1',
        inspectProcess: vi.fn(),
        dispatchCompletion,
        isLive: () => true
      })
      mocks.observeAgentHookCompletionForNotification.mockImplementation(({ payload, seedOnly }) =>
        seedOnly ? coordinator.seedHookStatus(payload) : coordinator.observeHookStatus(payload)
      )

      applySnapshot(frame(makeAgentSnapshot(1, NOW)), false)
      applySnapshot(frame(makeAgentSnapshot(2, NOW + 1_000, NOW + 1_000)), true)

      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    }
  )

  it('announces a host-stamped turn while client OSC status owns the pane', () => {
    const paneKey = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
    registerRendererOwnedAgentStatusPane(paneKey, ENVIRONMENT_ID)
    markRendererOwnedAgentStatusWrite(paneKey)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'review the PR',
          updatedAt: NOW,
          stateStartedAt: NOW,
          agentType: 'claude',
          paneKey,
          tabId: toWebTerminalSurfaceTabId(HOST_TAB_ID),
          worktreeId: WORKTREE_ID,
          stateHistory: []
        }
      }
    })
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey,
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    mocks.observeAgentHookCompletionForNotification.mockImplementation(({ payload, seedOnly }) =>
      seedOnly ? coordinator.seedHookStatus(payload) : coordinator.observeHookStatus(payload)
    )

    applySnapshot(makeAgentSnapshot(1, NOW - 2_000), true)
    const turnCompletedAt = NOW + 20_000
    applySnapshot(makeAgentSnapshot(2, NOW - 1_000, turnCompletedAt), true)
    applySnapshot(makeAgentSnapshot(3, NOW, turnCompletedAt, 'done'), true)

    expect(useAppStore.getState().agentStatusByPaneKey[paneKey]?.state).toBe('working')
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(3)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: expect.objectContaining({
          localStateStartedAt: NOW,
          turnCompletedAt
        })
      })
    )
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        source: 'hook',
        quietedHookDone: false,
        agentStatus: expect.objectContaining({
          state: 'done',
          prompt: 'review the PR',
          turnCompletedAt
        })
      })
    )
  })

  it('keeps a delayed host stamp bound to the prior client turn', () => {
    const paneKey = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
    registerRendererOwnedAgentStatusPane(paneKey, ENVIRONMENT_ID)
    markRendererOwnedAgentStatusWrite(paneKey)
    const setClientTurn = (stateStartedAt: number, prompt: string): void => {
      useAppStore.setState({
        agentStatusByPaneKey: {
          [paneKey]: {
            state: 'working',
            prompt,
            updatedAt: NOW,
            stateStartedAt,
            agentType: 'claude',
            paneKey,
            tabId: toWebTerminalSurfaceTabId(HOST_TAB_ID),
            worktreeId: WORKTREE_ID,
            stateHistory: []
          }
        }
      })
    }

    setClientTurn(5_000, 'first turn')
    applySnapshot(makeAgentSnapshot(1, NOW - 2_000), true)
    setClientTurn(6_000, 'second turn')
    applySnapshot(makeAgentSnapshot(2, NOW - 1_500), true)
    const turnCompletedAt = NOW + 20_000
    applySnapshot(makeAgentSnapshot(3, NOW - 1_000, turnCompletedAt), true)

    const delayedPayload =
      mocks.observeAgentHookCompletionForNotification.mock.calls.at(-1)?.[0]?.payload
    expect(delayedPayload).toMatchObject({
      localStateStartedAt: 5_000,
      turnCompletedAt
    })

    const notificationDispatch = vi.fn()
    vi.stubGlobal('window', { api: { notifications: { dispatch: notificationDispatch } } })
    dispatchTerminalNotification(WORKTREE_ID, {
      source: 'agent-task-complete',
      terminalTitle: 'Claude working',
      paneKey,
      agentCompletionSource: 'hook',
      agentStatusSnapshot: delayedPayload
    })

    expect(notificationDispatch).not.toHaveBeenCalled()
  })

  it('suppresses a stamped reconnect tail and its live all-clear', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID),
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    mocks.observeAgentHookCompletionForNotification.mockImplementation(({ payload, seedOnly }) =>
      seedOnly ? coordinator.seedHookStatus(payload) : coordinator.observeHookStatus(payload)
    )

    applySnapshot(makeAgentSnapshot(1, NOW, NOW), false)
    applySnapshot(makeAgentSnapshot(2, NOW + 1_000, NOW, 'done'), true)

    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(2)
    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('seeds an older restarted-host stamp without replaying its completion', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID),
      statusLane: 'hook',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    mocks.observeAgentHookCompletionForNotification.mockImplementation(({ payload, seedOnly }) =>
      seedOnly ? coordinator.seedHookStatus(payload) : coordinator.observeHookStatus(payload)
    )
    const firstTurnCompletedAt = NOW + 100_000
    const secondTurnCompletedAt = NOW + 200_000

    applySnapshot(makeAgentSnapshot(1, NOW), false)
    applySnapshot(makeAgentSnapshot(2, NOW + 1_000, firstTurnCompletedAt), true)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    applySnapshot(makeAgentSnapshot(3, NOW + 2_000), true)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(3)
    applySnapshot(makeAgentSnapshot(4, NOW + 3_000, secondTurnCompletedAt), true)
    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
    applySnapshot(makeAgentSnapshot(5, NOW + 4_000), true)

    applySnapshot(
      {
        ...makeAgentSnapshot(1, NOW + 5_000, firstTurnCompletedAt),
        publicationEpoch: 'epoch-2'
      },
      false
    )
    applySnapshot(
      {
        ...makeAgentSnapshot(2, NOW + 6_000, firstTurnCompletedAt, 'done'),
        publicationEpoch: 'epoch-2'
      },
      true
    )
    vi.advanceTimersByTime(1_500)

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })

  describe('reconnect hydration of a host-owned done', () => {
    let dispatchCompletion = vi.fn()

    beforeEach(() => {
      dispatchCompletion = vi.fn()
      const coordinator = createAgentCompletionCoordinator({
        paneKey: makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID),
        statusLane: 'hook',
        getPtyId: () => 'pty-1',
        inspectProcess: vi.fn(),
        dispatchCompletion,
        isLive: () => true
      })
      mocks.observeAgentHookCompletionForNotification.mockImplementation(({ payload, seedOnly }) =>
        seedOnly ? coordinator.seedHookStatus(payload) : coordinator.observeHookStatus(payload)
      )
    })

    it('announces a turn that finished while the host was unreachable', () => {
      applySnapshot(makeAgentSnapshot(1, NOW), true)
      applySnapshot(makeAgentSnapshot(2, NOW + 45_000, undefined, 'done', NOW + 15_000), false)
      vi.advanceTimersByTime(1_500)

      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
      expect(dispatchCompletion).toHaveBeenCalledWith(
        'claude',
        expect.objectContaining({
          source: 'hook',
          agentStatus: expect.objectContaining({ state: 'done', stateStartedAt: NOW + 15_000 })
        })
      )
    })

    it('announces a background turn stamped while the host was unreachable, once', () => {
      applySnapshot(makeAgentSnapshot(1, NOW), true)
      applySnapshot(makeAgentSnapshot(2, NOW + 45_000, NOW + 15_000), false)
      expect(dispatchCompletion).toHaveBeenCalledTimes(1)

      applySnapshot(makeAgentSnapshot(3, NOW + 46_000, NOW + 15_000), false)
      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    })

    it('seeds a stamped working row found on first load without announcing it', () => {
      applySnapshot(makeAgentSnapshot(1, NOW, NOW + 15_000), false)
      vi.advanceTimersByTime(1_500)

      expect(dispatchCompletion).not.toHaveBeenCalled()
    })

    it('seeds a done found on first load without announcing it', () => {
      applySnapshot(makeAgentSnapshot(1, NOW, undefined, 'done', NOW + 15_000), false)
      vi.advanceTimersByTime(1_500)

      expect(dispatchCompletion).not.toHaveBeenCalled()
    })

    it('does not re-announce a replayed done', () => {
      applySnapshot(makeAgentSnapshot(1, NOW), true)
      applySnapshot(makeAgentSnapshot(2, NOW + 1_000, undefined, 'done', NOW + 15_000), true)
      vi.advanceTimersByTime(1_500)
      expect(dispatchCompletion).toHaveBeenCalledTimes(1)

      applySnapshot(makeAgentSnapshot(3, NOW + 2_000, undefined, 'done', NOW + 15_000), false)
      applySnapshot(makeAgentSnapshot(4, NOW + 3_000, undefined, 'done', NOW + 15_000), false)
      vi.advanceTimersByTime(1_500)

      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    })
  })
})
