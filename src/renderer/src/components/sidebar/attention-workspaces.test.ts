import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { dashboardRowBucketProjection } from '@/components/dashboard/dashboard-row-bucket'
import { buildAttentionWorkspaceIds, type AttentionWorkspaceState } from './attention-workspaces'

const BASE = 1_700_000_000_000
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const PANE_1 = makePaneKey('tab1', LEAF_1)
const PANE_2 = makePaneKey('tab2', LEAF_2)
/** One of SYNTHETIC_AGENT_TITLE_PROFILES' permission labels, which Orca paints itself. */
const SYNTHETIC_PERMISSION_TITLE = 'Codex - action required'

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: 'w1',
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: BASE
  }
}

function entry(overrides: Partial<AgentStatusEntry> & { paneKey: string }): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'do the thing',
    updatedAt: BASE,
    stateStartedAt: BASE - 5_000,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

function leafLayout(tabId: string, leafId: string) {
  return {
    root: { type: 'leaf', leafId } as const,
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: `pty-${tabId}` }
  }
}

function state(overrides: Partial<AttentionWorkspaceState> = {}): AttentionWorkspaceState {
  return {
    agentStatusByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    folderWorkspaces: [],
    tabsByWorktree: { w1: [tab('tab1')] },
    ptyIdsByTabId: { tab1: ['pty-tab1'] },
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: { tab1: leafLayout('tab1', LEAF_1) },
    unifiedTabsByWorktree: {},
    worktreesByRepo: {},
    ...overrides
  }
}

describe('buildAttentionWorkspaceIds', () => {
  it('counts a workspace whose fresh agent is waiting', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        agentStatusByPaneKey: {
          [PANE_1]: entry({ paneKey: PANE_1, tabId: 'tab1', worktreeId: 'w1', state: 'waiting' })
        }
      }),
      BASE
    )

    expect([...ids]).toEqual(['w1'])
  })

  it('counts a blocked agent too', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        agentStatusByPaneKey: {
          [PANE_1]: entry({ paneKey: PANE_1, tabId: 'tab1', worktreeId: 'w1', state: 'blocked' })
        }
      }),
      BASE
    )

    expect([...ids]).toEqual(['w1'])
  })

  it('leaves a working agent out', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        agentStatusByPaneKey: {
          [PANE_1]: entry({ paneKey: PANE_1, tabId: 'tab1', worktreeId: 'w1' })
        }
      }),
      BASE
    )

    expect(ids.size).toBe(0)
  })

  it('drops a stale waiting row, matching the bucket it decays into', () => {
    const waiting = entry({
      paneKey: PANE_1,
      tabId: 'tab1',
      worktreeId: 'w1',
      state: 'waiting'
    })
    const now = BASE + AGENT_STATUS_STALE_AFTER_MS + 1

    const ids = buildAttentionWorkspaceIds(
      state({ agentStatusByPaneKey: { [PANE_1]: waiting } }),
      now
    )

    expect(ids.size).toBe(0)
    // The row the dashboard builds for the same entry decays to idle, not attention.
    expect(
      dashboardRowBucketProjection(
        {
          paneKey: waiting.paneKey,
          entry: waiting,
          state: 'idle',
          startedAt: waiting.stateStartedAt
        },
        { liveTurns: {}, retainedTurns: {}, acknowledgedTurnStartedAt: {} }
      ).bucket
    ).toBe('idle')
  })

  it('counts one workspace when two of its agents wait', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        tabsByWorktree: { w1: [tab('tab1'), { ...tab('tab2'), id: 'tab2' }] },
        ptyIdsByTabId: { tab1: ['pty-tab1'], tab2: ['pty-tab2'] },
        terminalLayoutsByTabId: {
          tab1: leafLayout('tab1', LEAF_1),
          tab2: leafLayout('tab2', LEAF_2)
        },
        agentStatusByPaneKey: {
          [PANE_1]: entry({ paneKey: PANE_1, tabId: 'tab1', worktreeId: 'w1', state: 'waiting' }),
          [PANE_2]: entry({ paneKey: PANE_2, tabId: 'tab2', worktreeId: 'w1', state: 'blocked' })
        }
      }),
      BASE
    )

    expect([...ids]).toEqual(['w1'])
  })

  it('agrees with the dashboard that an unsupported-migration row is attention', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        migrationUnsupportedByPtyId: {
          'pty-tab1': {
            ptyId: 'pty-tab1',
            paneKey: PANE_1,
            tabId: 'tab1',
            worktreeId: 'w1',
            reason: 'legacy-numeric-pane-key',
            source: 'local',
            updatedAt: BASE
          }
        }
      }),
      BASE
    )

    expect([...ids]).toEqual(['w1'])
  })

  it('reads a permission pane title when no fresh hook covers that leaf', () => {
    const ids = buildAttentionWorkspaceIds(
      state({ runtimePaneTitlesByTabId: { tab1: { 1: '❓ Claude needs your permission' } } }),
      BASE
    )

    expect([...ids]).toEqual(['w1'])
  })

  it('ignores pane titles on a tab with no live pty', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        ptyIdsByTabId: {},
        runtimePaneTitlesByTabId: { tab1: { 1: '❓ Claude needs your permission' } }
      }),
      BASE
    )

    expect(ids.size).toBe(0)
  })

  it('lets a fresh hook on the same leaf win over its pane title', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        agentStatusByPaneKey: {
          [PANE_1]: entry({ paneKey: PANE_1, tabId: 'tab1', worktreeId: 'w1' })
        },
        runtimePaneTitlesByTabId: { tab1: { 1: '❓ Claude needs your permission' } }
      }),
      BASE
    )

    expect(ids.size).toBe(0)
  })

  it('falls back to the persisted tab title before the first OSC frame lands', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        tabsByWorktree: {
          w1: [{ ...tab('tab1'), title: '❓ Claude needs your permission' }]
        },
        runtimePaneTitlesByTabId: {}
      }),
      BASE
    )

    expect([...ids]).toEqual(['w1'])
  })

  it('lets a restored hook row suppress the tab title restored alongside it', () => {
    const restoredTab = { ...tab('tab1'), title: '❓ Claude needs your permission' }

    // Control: the same restored title with no hook behind it still counts.
    expect(
      buildAttentionWorkspaceIds(
        state({ tabsByWorktree: { w1: [restoredTab] }, runtimePaneTitlesByTabId: {} }),
        BASE
      ).size
    ).toBe(1)

    const ids = buildAttentionWorkspaceIds(
      state({
        tabsByWorktree: { w1: [restoredTab] },
        runtimePaneTitlesByTabId: {},
        agentStatusByPaneKey: {
          [PANE_1]: entry({
            paneKey: PANE_1,
            tabId: 'tab1',
            worktreeId: 'w1',
            state: 'waiting',
            restoredUnconfirmed: true
          })
        }
      }),
      BASE
    )

    expect(ids.size).toBe(0)
  })

  it('lets a stale hook suppress the synthetic permission title it painted', () => {
    const stale = entry({
      paneKey: PANE_1,
      tabId: 'tab1',
      worktreeId: 'w1',
      state: 'waiting',
      updatedAt: BASE - AGENT_STATUS_STALE_AFTER_MS * 2,
      stateStartedAt: BASE - AGENT_STATUS_STALE_AFTER_MS * 2
    })
    const paneTitles = { tab1: { 1: SYNTHETIC_PERMISSION_TITLE } }

    // Control: the same title with no hook behind it is a real prompt and does count.
    expect(buildAttentionWorkspaceIds(state({ runtimePaneTitlesByTabId: paneTitles }), BASE).size) //
      .toBe(1)

    const ids = buildAttentionWorkspaceIds(
      state({ agentStatusByPaneKey: { [PANE_1]: stale }, runtimePaneTitlesByTabId: paneTitles }),
      BASE
    )

    expect(ids.size).toBe(0)
  })

  it('lets a fresh working hook suppress the parked copy of the permission title it painted', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        agentStatusByPaneKey: {
          [PANE_1]: entry({ paneKey: PANE_1, tabId: 'tab1', worktreeId: 'w1' })
        },
        // Slot -1 is the parked copy of leaf 0's title; slot 1 is the live pane after reopening.
        runtimePaneTitlesByTabId: { tab1: { [-1]: '❓ Claude needs your permission', 1: 'shell' } }
      }),
      BASE
    )

    expect(ids.size).toBe(0)
  })

  it('prefers the live pane title over the parked copy of the same leaf', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        runtimePaneTitlesByTabId: { tab1: { [-1]: '❓ Claude needs your permission', 1: 'shell' } }
      }),
      BASE
    )

    expect(ids.size).toBe(0)
  })

  it('still reads a parked permission title that no live slot or hook has replaced', () => {
    const ids = buildAttentionWorkspaceIds(
      state({ runtimePaneTitlesByTabId: { tab1: { [-1]: '❓ Claude needs your permission' } } }),
      BASE
    )

    expect([...ids]).toEqual(['w1'])
  })

  it('counts a stamped row whose tab this renderer never mirrored', () => {
    const ids = buildAttentionWorkspaceIds(
      state({
        tabsByWorktree: {},
        agentStatusByPaneKey: {
          [PANE_2]: entry({ paneKey: PANE_2, tabId: 'tab2', worktreeId: 'w2', state: 'waiting' })
        }
      }),
      BASE
    )

    expect([...ids]).toEqual(['w2'])
  })
})
