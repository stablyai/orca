import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAutoAckTabTargets } from './agent-auto-ack-targets'
import {
  computeAgentAcknowledgementTargets,
  computeLapsedManualUnreadProtections,
  resolveViewedUnreadSubjectKey
} from '@/attention/agent-attention-acknowledgement'
import { createTestStore, makeTab, makeUnifiedTab } from '../store/slices/store-test-helpers'
import type { RetainedAgentEntry } from '../store/slices/agent-status'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'

const CODEX_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

type TestStore = ReturnType<typeof createTestStore>

/** Subject-keyed turn view the neutral acknowledgement policy reads. */
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

// Why: regression coverage for the codex inline-agent row that stayed bold
// after returning from another workspace (docs/codex-agent-row-bold-stuck.md).
// The race: codex emits `Stop` (state=done), then its TUI title reverts to a
// shell label; pty-connection.ts:onAgentExited fires removeAgentStatus before
// the live `done` row could be auto-acked. The retention sync snapshots the
// `done` row into retainedAgentsByPaneKey carrying a fresh stateStartedAt.
// Pre-fix: useReadOnScreenAttention only walked the live map, so the retained
// row's stateStartedAt > ackAt forever. Fix: walk both maps.
//
// We test the pure helper (computeAgentAcknowledgementTargets) rather than the hook so the
// vitest 'node' environment doesn't need to mock document.visibilityState,
// document.hasFocus, or the focus/visibilitychange event surface. The hook's
// gate logic is unchanged by this fix — only the scan body was extended.

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

    // 1. Codex starts working, user acks it (e.g. by clicking the row).
    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: 'sleep 10 then say hi',
      agentType: 'codex'
    })
    store.getState().acknowledgeAgents([paneKey])
    const workingAck = store.getState().acknowledgedAgentsByPaneKey[paneKey]
    expect(workingAck).toBeGreaterThan(0)

    // 2. Time advances; codex Stop fires → state=done with a fresh
    //    stateStartedAt (carry-forward only applies within the same state).
    vi.setSystemTime(new Date('2026-05-05T12:00:10.000Z'))
    store.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: 'sleep 10 then say hi',
      agentType: 'codex'
    })
    const liveDone = store.getState().agentStatusByPaneKey[paneKey]
    expect(liveDone.stateStartedAt).toBeGreaterThan(workingAck)

    // 3. The codex TUI title reverts to a plain shell label, so
    //    onAgentExited → removeAgentStatus tears down the live entry AND
    //    wipes the prior ack (per agent-status.ts cleanup contract).
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

    // 4. The retention sync picks up the live→gone transition and stashes a
    //    snapshot with the post-Stop stateStartedAt — same as
    //    collectRetainedAgentsOnDisappear in useRetainedAgents.ts.
    store.getState().retainAgents([retentionSnapshot])
    expect(store.getState().retainedAgentsByPaneKey[paneKey]).toBeDefined()

    // 5. The user is back on the codex tab. computeAgentAcknowledgementTargets must see
    //    the retained row and surface it for ack — pre-fix this returned [].
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

    // First scan: the retained row is unvisited.
    expect(ackTargets(store, activeTabId, CODEX_LEAF_ID)).toEqual([paneKey])

    // Simulate the ack effect.
    vi.setSystemTime(new Date('2026-05-05T12:00:01.000Z'))
    store.getState().acknowledgeAgents([paneKey])

    // Second scan: idempotent — nothing to ack.
    expect(ackTargets(store, activeTabId, CODEX_LEAF_ID)).toEqual([])
  })

  it('skips retained rows whose paneKey is on a different tab', () => {
    const store = createTestStore()
    const paneKey = makePaneKey('tab-other', OTHER_LEAF_ID)
    store.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: 'p',
      agentType: 'codex'
    })
    const entry = store.getState().agentStatusByPaneKey[paneKey]
    store.getState().retainAgents([
      {
        entry,
        worktreeId: 'wt-1',
        tab: makeTab({ id: 'tab-other', worktreeId: 'wt-1' }),
        agentType: 'codex',
        startedAt: entry.stateStartedAt
      }
    ])
    store.getState().removeAgentStatus(paneKey)

    // Active tab differs — the retained row must NOT be acked while the user
    // is looking at a different tab; the bold-until-viewed signal must
    // survive the tab switch.
    expect(ackTargets(store, 'tab-codex', CODEX_LEAF_ID)).toEqual([])
  })

  it('skips sibling panes in the same terminal tab', () => {
    const store = createTestStore()
    const activeTabId = 'tab-split'
    const activePaneKey = makePaneKey(activeTabId, CODEX_LEAF_ID)
    const siblingPaneKey = makePaneKey(activeTabId, OTHER_LEAF_ID)

    store.getState().setAgentStatus(activePaneKey, {
      state: 'done',
      prompt: 'visible pane',
      agentType: 'codex'
    })
    store.getState().setAgentStatus(siblingPaneKey, {
      state: 'done',
      prompt: 'hidden sibling pane',
      agentType: 'claude'
    })

    expect(ackTargets(store, activeTabId, CODEX_LEAF_ID)).toEqual([activePaneKey])
  })

  it('acks a paneKey present in BOTH live and retained without throwing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00.000Z'))
    const store = createTestStore()
    const activeTabId = 'tab-codex'
    const paneKey = makePaneKey(activeTabId, CODEX_LEAF_ID)

    // Construct a (rare) state where retainedAgentsByPaneKey and
    // agentStatusByPaneKey both contain the same paneKey — e.g. the
    // retention sync hadn't observed the new live entry yet. The merged
    // scan should report the paneKey at most twice (acknowledgeAgents
    // collapses duplicates), never throw.
    store.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: 'p1',
      agentType: 'codex'
    })
    const liveDone = store.getState().agentStatusByPaneKey[paneKey]
    store.getState().retainAgents([
      {
        entry: liveDone,
        worktreeId: 'wt-1',
        tab: makeTab({ id: activeTabId, worktreeId: 'wt-1' }),
        agentType: 'codex',
        startedAt: liveDone.stateStartedAt
      }
    ])

    const targets = ackTargets(store, activeTabId, CODEX_LEAF_ID)
    // Two pushes, same paneKey — duplicates are intentional and harmless;
    // acknowledgeAgents short-circuits per key.
    expect(targets.length).toBeLessThanOrEqual(2)
    expect(targets.every((k) => k === paneKey)).toBe(true)
    expect(targets.includes(paneKey)).toBe(true)
  })
})

describe('resolveViewedUnreadSubjectKey', () => {
  it('returns the exact active pane unread marker', () => {
    const paneKey = makePaneKey('tab-1', CODEX_LEAF_ID)

    expect(resolveViewedUnreadSubjectKey({ [paneKey]: 'agent-completion' }, paneKey)).toBe(paneKey)
  })

  it('reads an unclassified legacy boolean marker as unread', () => {
    const paneKey = makePaneKey('tab-1', CODEX_LEAF_ID)

    expect(resolveViewedUnreadSubjectKey({ [paneKey]: true }, paneKey)).toBe(paneKey)
  })

  it('skips unread markers for hidden sibling panes', () => {
    const siblingPaneKey = makePaneKey('tab-1', OTHER_LEAF_ID)

    expect(
      resolveViewedUnreadSubjectKey(
        { [siblingPaneKey]: 'agent-completion' },
        makePaneKey('tab-1', CODEX_LEAF_ID)
      )
    ).toBeNull()
  })
})

describe('agent completion pane unread store marker', () => {
  it('clears through the on-screen read of its tab', () => {
    const store = createTestStore()
    const paneKey = makePaneKey('tab-1', CODEX_LEAF_ID)

    store.getState().markAgentAttentionUnread({
      workspaceId: 'wt-1',
      subjectKey: paneKey,
      groupId: 'tab-1',
      reason: 'agent-completion'
    })
    expect(store.getState().unreadAgentCompletionPanes).toEqual({
      [paneKey]: 'agent-completion'
    })

    store
      .getState()
      .readOnScreenAttention(
        { workspaceIds: ['wt-1'], targets: [{ worktreeId: 'wt-1', tabId: 'tab-1' }] },
        { screenArrived: false }
      )
    expect(store.getState().unreadAgentCompletionPanes).toEqual({})
  })
})

describe('resolveAutoAckTabTargets', () => {
  const FLOATING_TAB_ID = 'tab-floating'
  /** One group per workspace showing `tabIds[worktreeId]`. */
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

  it('scans the floating tab alongside the main tab while the panel is visible', () => {
    expect(resolveAutoAckTabTargets(baseState)).toEqual([
      {
        tabId: FLOATING_TAB_ID,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        surfaceKind: 'terminal'
      },
      { tabId: 'tab-1', worktreeId: 'wt-1', surfaceKind: 'terminal' }
    ])
  })

  it('skips the floating tab while the panel is closed', () => {
    expect(resolveAutoAckTabTargets({ ...baseState, ...panelClosed })).toEqual([
      { tabId: 'tab-1', worktreeId: 'wt-1', surfaceKind: 'terminal' }
    ])
  })

  it('skips the floating tab while the feature is disabled, even with the panel left open', () => {
    const disabled = { ...baseState.settings, floatingTerminalEnabled: false }
    expect(resolveAutoAckTabTargets({ ...baseState, settings: disabled })).toEqual([
      { tabId: 'tab-1', worktreeId: 'wt-1', surfaceKind: 'terminal' }
    ])
  })

  it('scans the floating tab outside the terminal view because the panel overlays every view', () => {
    expect(resolveAutoAckTabTargets({ ...baseState, activeView: 'activity' })).toEqual([
      { tabId: FLOATING_TAB_ID, worktreeId: FLOATING_TERMINAL_WORKTREE_ID, surfaceKind: 'terminal' }
    ])
  })

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

  it('scans nothing outside the terminal view with the panel closed', () => {
    expect(
      resolveAutoAckTabTargets({ ...baseState, ...panelClosed, activeView: 'activity' })
    ).toEqual([])
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
    // Persisted UI (manual-unread stamps) hydrates before the agent-status snapshot; a focused
    // scan in that window must not treat "no row yet" as "the agent moved on".
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

  it('keeps an active pane whose turn is unchanged', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(paneKey, { state: 'done', prompt: 'p', agentType: 'claude' })
    const turn = store.getState().agentStatusByPaneKey[paneKey]!.stateStartedAt
    const lapsed = computeLapsedManualUnreadProtections(
      {
        liveTurns: store.getState().agentStatusByPaneKey,
        retainedTurns: store.getState().retainedAgentsByPaneKey,
        manuallyUnreadTurnStartedAt: { [paneKey]: turn }
      },
      new Set([paneKey])
    )
    expect(lapsed).toEqual([])
  })
})
