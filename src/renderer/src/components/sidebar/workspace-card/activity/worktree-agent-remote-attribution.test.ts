import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../../../shared/workspace-layout/terminal-surface-id'
import { applyWebSessionTabsSnapshot } from '../../../../runtime/web-session-tabs-sync/snapshot-api'
import {
  ENV,
  LEAF_ID,
  NOW,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../../../../runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'

vi.mock('../../../../store/index', () => ({ useAppStore: { setState: vi.fn() } }))

function status(tabId: string, worktreeId: string): AgentStatusEntry {
  return {
    paneKey: makePaneKey(tabId, LEAF_ID),
    tabId,
    worktreeId,
    agentType: 'omp',
    state: 'done',
    prompt: 'Finished the change',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: []
  }
}

function hostSnapshot(tabId: string, worktreeId: string) {
  return makeSnapshot(
    [
      {
        type: 'terminal',
        id: `${tabId}::${LEAF_ID}`,
        parentTabId: tabId,
        leafId: LEAF_ID,
        title: 'OMP',
        isActive: false,
        status: 'ready',
        terminal: `terminal-${tabId}`,
        agentStatus: status(tabId, worktreeId)
      }
    ],
    { worktree: worktreeId }
  )
}

describe('remote completed sidebar rows before tab hydration', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('retracts only the publishing host and workspace when client tabs are missing', () => {
    const worktreeId = 'folder:remote-workspace'
    const initial = makeState()
    const owner = applyWebSessionTabsSnapshot(initial, hostSnapshot('owner', worktreeId), ENV, NOW)
    const sibling = applyWebSessionTabsSnapshot(
      initial,
      hostSnapshot('sibling', worktreeId),
      'other-host',
      NOW
    )
    const otherWorkspace = applyWebSessionTabsSnapshot(
      initial,
      hostSnapshot('other-workspace', 'folder:other'),
      ENV,
      NOW
    )
    const unknown = status(toWebTerminalSurfaceTabId('unknown-owner'), worktreeId)
    const store = createTestStore()
    store.setState(
      makeState({
        agentStatusByPaneKey: acceptedAgentStatuses([
          ...(owner.agentStatusByPaneKey ?? acceptedAgentStatuses()),
          ...(sibling.agentStatusByPaneKey ?? acceptedAgentStatuses()),
          ...(otherWorkspace.agentStatusByPaneKey ?? acceptedAgentStatuses()),
          [unknown.paneKey, unknown] as const
        ])
      })
    )
    const beforeTabs = store.getState()
    store.setState(
      applyWebSessionTabsSnapshot(
        beforeTabs,
        makeSnapshot([], { worktree: worktreeId, snapshotVersion: 2 }),
        ENV,
        NOW + 1
      )
    )
    const removed = store.getState()
    expect(Array.from(removed.agentStatusByPaneKey.keys()).sort()).toEqual(
      [
        makePaneKey(toWebTerminalSurfaceTabId('sibling'), LEAF_ID),
        makePaneKey(toWebTerminalSurfaceTabId('other-workspace'), LEAF_ID),
        unknown.paneKey
      ].sort()
    )
  })

  it('does not treat workspace visibility removal as host tab retraction', () => {
    const worktreeId = 'folder:remote-workspace'
    const initial = makeState()
    const mirror = applyWebSessionTabsSnapshot(
      initial,
      hostSnapshot('host-tab', worktreeId),
      ENV,
      NOW
    )
    const beforeTabs = makeState({ agentStatusByPaneKey: mirror.agentStatusByPaneKey })
    const tombstone = {
      ...makeSnapshot([], {
        worktree: worktreeId,
        publicationEpoch: 'visibility-inventory-removal'
      }),
      removed: true as const
    }
    const removed = {
      ...beforeTabs,
      ...applyWebSessionTabsSnapshot(beforeTabs, tombstone, ENV, NOW + 1)
    }
    expect(removed.agentStatusByPaneKey).toEqual(beforeTabs.agentStatusByPaneKey)
  })
})
