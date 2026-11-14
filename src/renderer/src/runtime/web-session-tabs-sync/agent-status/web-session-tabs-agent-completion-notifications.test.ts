import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { resetAgentCompletionCoordinatorIdentitiesForTest } from '@/components/terminal-pane/agent-completion/agent-completion-identity-store'
import { dispatchTerminalNotification } from '../../../components/terminal-pane/notifications/dispatch-terminal-notification'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '@/components/terminal-pane/agent-status/renderer-owned-agent-status-registry'
import { applyWebSessionTabsSnapshot } from '../snapshot-api'
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
})
