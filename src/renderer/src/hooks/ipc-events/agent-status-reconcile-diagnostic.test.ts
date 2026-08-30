import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '../../store/slices/store-test-helpers'
import type { AppState } from '../../store/types'

const WORKTREE_ID = 'wt-diagnostic'
const TAB_ID = 'tab-diagnostic'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

describe('agent status reconcile diagnostic', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('retains a diagnostic and applies its explicit clear', async () => {
    const store = createTestStore()
    store.setState({
      workspaceSessionReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: WORKTREE_ID, repoId: TEST_REPO.id })]
      },
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID, title: 'Codex', ptyId: 'pty-1' })
        ]
      },
      terminalLayoutsByTabId: {
        [TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      }
    } as Partial<AppState>)
    vi.doMock('../../store', () => ({ useAppStore: { getState: store.getState } }))
    vi.doMock('@/lib/telemetry', () => ({ track: vi.fn() }))
    vi.doMock('../agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification: vi.fn()
    }))
    const { createAgentStatusEventApplicator } = await import('./agent-status-event-applicator')
    const apply = createAgentStatusEventApplicator({
      pendingAgentStatusEvents: [],
      transientClearWatermarkByConnectionId: new Map(),
      enqueuePendingAgentStatus: vi.fn()
    })
    const diagnostic = {
      kind: 'unverifiable' as const,
      reason: 'transcript-unreadable' as const,
      observedAt: 123
    }

    expect(
      apply({
        paneKey: PANE_KEY,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        connectionId: null,
        state: 'working',
        prompt: 'recover state',
        agentType: 'codex',
        receivedAt: 1,
        stateStartedAt: 1,
        reconcileDiagnostic: diagnostic
      })
    ).toBe('applied')
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.reconcileDiagnostic).toEqual(diagnostic)

    expect(
      apply({
        paneKey: PANE_KEY,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        connectionId: null,
        state: 'working',
        prompt: 'recover state',
        agentType: 'codex',
        receivedAt: 2,
        stateStartedAt: 1,
        reconcileDiagnostic: null
      })
    ).toBe('applied')
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.reconcileDiagnostic).toBeNull()
  })
})
