import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusChange } from '@/store/slices/agent-status/agent-status-contract'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

const mocks = vi.hoisted(() => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: mocks.observeAgentHookCompletionForNotification
}))

import { useAppStore } from '@/store'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from '@/components/terminal-pane/agent-completion-coordinator'
import { dispatchTerminalNotification } from '@/components/terminal-pane/use-notification-dispatch'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '@/components/terminal-pane/renderer-owned-agent-status-registry'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  applyWebSessionTabsSnapshotOperations
} from './web-session-tabs-sync/snapshot-api'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

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

function applySnapshot(snapshot: RuntimeMobileSessionTabsResult, live: boolean): void {
  const decision = decideWebSessionTabsSnapshot(snapshot, ENVIRONMENT_ID)
  applyWebSessionTabsStorePatch(
    (state, changedAgentPaneKeys) =>
      applyWebSessionTabsSnapshot(
        state,
        snapshot,
        ENVIRONMENT_ID,
        NOW,
        undefined,
        changedAgentPaneKeys
      ),
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

  it('forwards accepted working snapshots and live statuses', () => {
    applySnapshot(makeAgentSnapshot(1, NOW), false)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(1)

    applySnapshot(makeAgentSnapshot(2, NOW + 1_000), true)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(2)

    const turnCompletedAt = NOW + 2_000
    applySnapshot(makeAgentSnapshot(3, NOW + 2_000, turnCompletedAt), true)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenLastCalledWith({
      paneKey: makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID),
      worktreeId: WORKTREE_ID,
      payload: expect.objectContaining({
        state: 'working',
        stateStartedAt: NOW,
        turnCompletedAt
      })
    })

    applySnapshot(makeAgentSnapshot(4, NOW + 3_000, turnCompletedAt + 1_000), false)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(4)
  })

  // STA-12043: a cold-restored host republishes the old turn as unverifiable under a new date.
  it('announces no completion for an unverifiable done', () => {
    applySnapshot(makeAgentSnapshot(1, NOW, undefined, 'done', NOW), true)
    const announced = mocks.observeAgentHookCompletionForNotification.mock.calls.length
    const restored = makeAgentSnapshot(2, NOW + 60_000, undefined, 'done', NOW + 60_000)
    const [tab] = restored.tabs
    if (tab?.type === 'terminal' && tab.agentStatus) {
      tab.agentStatus.restoredUnconfirmed = true
    }

    applySnapshot(restored, true)

    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(announced)
  })

  it('announces one live stamped completion after a late-pair working seed', () => {
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

    applySnapshot(makeAgentSnapshot(1, NOW), false)
    applySnapshot(makeAgentSnapshot(2, NOW + 1_000, NOW + 1_000), true)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

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
