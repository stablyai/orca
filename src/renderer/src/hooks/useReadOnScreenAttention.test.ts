import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAutoAckTabTargets } from './agent-auto-ack-targets'
import {
  computeAgentAcknowledgementTargets,
  computeLapsedManualUnreadProtections
} from '@/attention/agent-attention-acknowledgement'
import { createTestStore, makeTab, makeUnifiedTab } from '../store/slices/store-test-helpers'
import type { RetainedAgentEntry } from '../store/slices/agent-status/agent-status-contract'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'

const CODEX_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

type TestStore = ReturnType<typeof createTestStore>

function ackTargets(store: TestStore, tabId: string, leafId: string): string[] {
  const state = store.getState()
  return computeAgentAcknowledgementTargets(
    {
      liveTurns: state.agentStatusByPaneKey,
      retainedTurns: state.retainedAgentsByPaneKey,
      acknowledgedTurnStartedAt: state.acknowledgedAgentsByPaneKey
    },
    makePaneKey(tabId, leafId)
  )
}

// Codex Stop can migrate done state to retained rows before view acknowledgement; scan both live and retained maps or the row stays bold forever (codex-agent-row-bold-stuck.md). Test the pure target selector independently of DOM presence gates.

describe('computeAgentAcknowledgementTargets — codex retain race regression', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('acks a paneKey whose live row was retained mid-frame', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00.000Z'))
    const store = createTestStore()
    const activeTabId = 'tab-codex'
    const paneKey = makePaneKey(activeTabId, CODEX_LEAF_ID)

    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: 'sleep 10 then say hi',
      agentType: 'codex'
    })
    store.getState().acknowledgeAgents([paneKey])
    const workingAck = store.getState().acknowledgedAgentsByPaneKey[paneKey]
    expect(workingAck).toBeGreaterThan(0)

    vi.setSystemTime(new Date('2026-05-05T12:00:10.000Z'))
    store.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: 'sleep 10 then say hi',
      agentType: 'codex'
    })
    const liveDone = store.getState().agentStatusByPaneKey[paneKey]
    expect(liveDone.stateStartedAt).toBeGreaterThan(workingAck)

    const retentionSnapshot: RetainedAgentEntry = {
      entry: liveDone,
      worktreeId: 'wt-1',
      tab: makeTab({ id: activeTabId, worktreeId: 'wt-1' }),
      agentType: 'codex',
      startedAt: liveDone.stateStartedAt
    }
    store.getState().removeAgentStatus(paneKey)
    expect(store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().acknowledgedAgentsByPaneKey[paneKey]).toBeUndefined()

    store.getState().retainAgents([retentionSnapshot])
    expect(store.getState().retainedAgentsByPaneKey[paneKey]).toBeDefined()

    const targets = ackTargets(store, activeTabId, CODEX_LEAF_ID)
    expect(targets).toEqual([paneKey])
  })

  it('returns no targets once the retained row has been acked', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00.000Z'))
    const store = createTestStore()
    const activeTabId = 'tab-codex'
    const paneKey = makePaneKey(activeTabId, CODEX_LEAF_ID)

    store.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: 'p',
      agentType: 'codex'
    })
    const doneEntry = store.getState().agentStatusByPaneKey[paneKey]
    store.getState().retainAgents([
      {
        entry: doneEntry,
        worktreeId: 'wt-1',
        tab: makeTab({ id: activeTabId, worktreeId: 'wt-1' }),
        agentType: 'codex',
        startedAt: doneEntry.stateStartedAt
      }
    ])
    store.getState().removeAgentStatus(paneKey)

    expect(ackTargets(store, activeTabId, CODEX_LEAF_ID)).toEqual([paneKey])

    vi.setSystemTime(new Date('2026-05-05T12:00:01.000Z'))
    store.getState().acknowledgeAgents([paneKey])

    expect(ackTargets(store, activeTabId, CODEX_LEAF_ID)).toEqual([])
  })
})

describe('resolveAutoAckTabTargets', () => {
  const FLOATING_TAB_ID = 'tab-floating'
  const withActiveTabs = (tabIds: Record<string, string>) => ({
    groupsByWorktree: Object.fromEntries(
      Object.entries(tabIds).map(([worktreeId, tabId]) => [
        worktreeId,
        [{ id: `${worktreeId}-group`, activeTabId: tabId }]
      ])
    ),
    activeGroupIdByWorktree: Object.fromEntries(
      Object.keys(tabIds).map((worktreeId) => [worktreeId, `${worktreeId}-group`])
    ),
    unifiedTabsByWorktree: Object.fromEntries(
      Object.entries(tabIds).map(([worktreeId, tabId]) => [
        worktreeId,
        [makeUnifiedTab({ id: tabId, worktreeId, groupId: `${worktreeId}-group` })]
      ])
    )
  })
  const baseState = {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    ...withActiveTabs({ [FLOATING_TERMINAL_WORKTREE_ID]: FLOATING_TAB_ID, 'wt-1': 'tab-1' }),
    settings: { ...getDefaultSettings('/home/test'), floatingTerminalEnabled: true },
    floatingWorkspacePanelOpen: true
  }
  const panelClosed = { floatingWorkspacePanelOpen: false }

  it('scans the active tab of every visible group of a split layout', () => {
    const state = {
      ...baseState,
      ...panelClosed,
      groupsByWorktree: {
        'wt-1': [
          { id: 'left', activeTabId: 'tab-1' },
          { id: 'right', activeTabId: 'tab-2' }
        ]
      },
      activeGroupIdByWorktree: { 'wt-1': 'right' },
      layoutByWorktree: {
        'wt-1': {
          type: 'split' as const,
          direction: 'horizontal' as const,
          first: { type: 'leaf' as const, groupId: 'left' },
          second: { type: 'leaf' as const, groupId: 'right' }
        }
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({ id: 'tab-1', worktreeId: 'wt-1', groupId: 'left' }),
          makeUnifiedTab({ id: 'tab-2', worktreeId: 'wt-1', groupId: 'right' })
        ]
      }
    }
    expect(resolveAutoAckTabTargets(state)).toEqual([
      { tabId: 'tab-2', worktreeId: 'wt-1', surfaceKind: 'terminal' },
      { tabId: 'tab-1', worktreeId: 'wt-1', surfaceKind: 'terminal' }
    ])
  })

  it('prefers the visible floating worktree when both worktrees claim one tab id', () => {
    expect(
      resolveAutoAckTabTargets({
        ...baseState,
        ...withActiveTabs({
          [FLOATING_TERMINAL_WORKTREE_ID]: FLOATING_TAB_ID,
          'wt-1': FLOATING_TAB_ID
        })
      })
    ).toEqual([
      { tabId: FLOATING_TAB_ID, worktreeId: FLOATING_TERMINAL_WORKTREE_ID, surfaceKind: 'terminal' }
    ])
  })
})

describe('computeLapsedManualUnreadProtections', () => {
  const paneKey = makePaneKey('tab-1', CODEX_LEAF_ID)
  const otherPaneKey = makePaneKey('tab-1', OTHER_LEAF_ID)

  it('keeps an active pane whose status row has not arrived yet (startup race)', () => {
    // Manual-unread hydration can precede status rows; missing evidence must not mean the agent moved on.
    const lapsed = computeLapsedManualUnreadProtections(
      {
        liveTurns: {},
        retainedTurns: {},
        manuallyUnreadTurnStartedAt: { [paneKey]: 1_000 }
      },
      new Set([paneKey])
    )
    expect(lapsed).toEqual([])
  })

  it('lapses a pane that is no longer active or whose agent took a new turn', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(paneKey, { state: 'done', prompt: 'p', agentType: 'claude' })
    const turn = store.getState().agentStatusByPaneKey[paneKey]!.stateStartedAt
    const lapsed = computeLapsedManualUnreadProtections(
      {
        liveTurns: store.getState().agentStatusByPaneKey,
        retainedTurns: store.getState().retainedAgentsByPaneKey,
        manuallyUnreadTurnStartedAt: { [paneKey]: turn - 1, [otherPaneKey]: 5 }
      },
      new Set([paneKey])
    )
    expect(lapsed.sort()).toEqual([paneKey, otherPaneKey].sort())
  })
})
