import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAutoAckTabTargets } from './useAutoAckViewedAgent'
import {
  applyAgentAttentionAcknowledgement,
  computeAgentAcknowledgementTargets,
  computeLapsedManualUnreadProtections,
  resolveViewedUnreadSubjectKey,
  shouldClearWorkspaceAttention
} from '@/attention/agent-attention-acknowledgement'
import { createTerminalAttentionSurface } from '@/components/terminal-pane/terminal-attention-surface'
import { createTestStore, makeTab } from '../store/slices/store-test-helpers'
import { selectFloatingWorkspaceHasUnread } from '../store/selectors'
import type { RetainedAgentEntry } from '../store/slices/agent-status'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
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
// Pre-fix: useAutoAckViewedAgent only walked the live map, so the retained
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

describe('applyAgentAttentionAcknowledgement', () => {
  it('acks the visible agent and clears unread worktree/tab/pane attention', () => {
    const actions = {
      acknowledgeSubjects: vi.fn(),
      clearWorkspaceUnread: vi.fn(),
      clearGroupUnread: vi.fn(),
      clearSubjectUnread: vi.fn()
    }
    const paneKey = makePaneKey('tab-1', CODEX_LEAF_ID)

    applyAgentAttentionAcknowledgement(actions, {
      workspaceIdToClear: 'wt-1',
      viewedGroupId: 'tab-1',
      subjectKeys: [paneKey]
    })

    expect(actions.acknowledgeSubjects).toHaveBeenCalledWith([paneKey])
    expect(actions.clearWorkspaceUnread).toHaveBeenCalledWith('wt-1')
    expect(actions.clearGroupUnread).toHaveBeenCalledWith('tab-1')
    expect(actions.clearSubjectUnread).toHaveBeenCalledWith(paneKey)
  })

  it('does nothing when there are no visible agent targets', () => {
    const actions = {
      acknowledgeSubjects: vi.fn(),
      clearWorkspaceUnread: vi.fn(),
      clearGroupUnread: vi.fn(),
      clearSubjectUnread: vi.fn()
    }

    applyAgentAttentionAcknowledgement(actions, {
      workspaceIdToClear: 'wt-1',
      viewedGroupId: 'tab-1',
      subjectKeys: []
    })

    expect(actions.acknowledgeSubjects).not.toHaveBeenCalled()
    expect(actions.clearWorkspaceUnread).not.toHaveBeenCalled()
    expect(actions.clearGroupUnread).not.toHaveBeenCalled()
    expect(actions.clearSubjectUnread).not.toHaveBeenCalled()
  })

  it('clears visible pane unread even when there is no agent row to acknowledge', () => {
    const actions = {
      acknowledgeSubjects: vi.fn(),
      clearWorkspaceUnread: vi.fn(),
      clearGroupUnread: vi.fn(),
      clearSubjectUnread: vi.fn()
    }
    const paneKey = makePaneKey('tab-1', CODEX_LEAF_ID)

    applyAgentAttentionAcknowledgement(actions, {
      workspaceIdToClear: 'wt-1',
      viewedGroupId: 'tab-1',
      subjectKeys: [],
      viewedUnreadSubjectKey: paneKey
    })

    expect(actions.acknowledgeSubjects).not.toHaveBeenCalled()
    expect(actions.clearWorkspaceUnread).toHaveBeenCalledWith('wt-1')
    expect(actions.clearGroupUnread).toHaveBeenCalledWith('tab-1')
    expect(actions.clearSubjectUnread).toHaveBeenCalledWith(paneKey)
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
  it('clears through the normal pane-unread clear path', () => {
    const store = createTestStore()
    const paneKey = makePaneKey('tab-1', CODEX_LEAF_ID)

    store.getState().markAgentCompletionPaneUnread(paneKey, 'agent-completion')
    expect(store.getState().unreadAgentCompletionPanes).toEqual({
      [paneKey]: 'agent-completion'
    })

    store.getState().clearTerminalPaneUnread(paneKey)
    expect(store.getState().unreadAgentCompletionPanes).toEqual({})
  })
})

describe('shouldClearWorkspaceAttention through the terminal surface', () => {
  function seedWorkspace(seed: {
    tabIds: string[]
    unreadAgentCompletionPanes: Record<string, 'agent-completion'>
    unreadTerminalTabs?: Record<string, 'terminal-bell'>
  }): TestStore {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': seed.tabIds.map((id) => makeTab({ id, worktreeId: 'wt-1' }))
      },
      unreadAgentCompletionPanes: seed.unreadAgentCompletionPanes,
      unreadTerminalTabs: seed.unreadTerminalTabs ?? {}
    })
    return store
  }

  function clearsWorkspace(store: TestStore, clearedSubjectKeys: Set<string>): boolean {
    const surface = createTerminalAttentionSurface(store.getState())
    return shouldClearWorkspaceAttention(surface.collectWorkspaceAttentionRemainder('wt-1'), {
      viewedGroupId: 'tab-1',
      clearedSubjectKeys
    })
  }

  it('clears worktree unread when the visible pane owns the only agent source', () => {
    const paneKey = makePaneKey('tab-1', CODEX_LEAF_ID)
    const store = seedWorkspace({
      tabIds: ['tab-1'],
      unreadAgentCompletionPanes: { [paneKey]: 'agent-completion' }
    })

    expect(clearsWorkspace(store, new Set([paneKey]))).toBe(true)
  })

  it('keeps worktree unread when a hidden tab still owns agent attention', () => {
    const activePaneKey = makePaneKey('tab-1', CODEX_LEAF_ID)
    const hiddenPaneKey = makePaneKey('tab-2', OTHER_LEAF_ID)
    const store = seedWorkspace({
      tabIds: ['tab-1', 'tab-2'],
      unreadAgentCompletionPanes: {
        [activePaneKey]: 'agent-completion',
        [hiddenPaneKey]: 'agent-completion'
      }
    })

    expect(clearsWorkspace(store, new Set([activePaneKey]))).toBe(false)
  })

  it('keeps worktree unread when a hidden tab has terminal unread attention', () => {
    const activePaneKey = makePaneKey('tab-1', CODEX_LEAF_ID)
    const store = seedWorkspace({
      tabIds: ['tab-1', 'tab-2'],
      unreadAgentCompletionPanes: { [activePaneKey]: 'agent-completion' },
      unreadTerminalTabs: { 'tab-2': 'terminal-bell' }
    })

    expect(clearsWorkspace(store, new Set([activePaneKey]))).toBe(false)
  })

  it('ignores unread panes owned by another workspace', () => {
    const activePaneKey = makePaneKey('tab-1', CODEX_LEAF_ID)
    const foreignPaneKey = makePaneKey('tab-elsewhere', OTHER_LEAF_ID)
    const store = seedWorkspace({
      tabIds: ['tab-1'],
      unreadAgentCompletionPanes: {
        [activePaneKey]: 'agent-completion',
        [foreignPaneKey]: 'agent-completion'
      }
    })

    expect(clearsWorkspace(store, new Set([activePaneKey]))).toBe(true)
  })
})

describe('resolveAutoAckTabTargets', () => {
  const FLOATING_TAB_ID = 'tab-floating'
  const GRID_TAB_ID = 'tab-grid'
  const baseState = {
    activeView: 'terminal',
    activeTabId: 'tab-1',
    activeWorktreeId: 'wt-1',
    activeSessionGridTabId: null,
    sessionsGridFilter: 'all' as const,
    sessionsGridHiddenTabIds: new Array<string>(),
    activeTabIdByWorktree: {
      'wt-1': 'tab-1',
      [FLOATING_TERMINAL_WORKTREE_ID]: FLOATING_TAB_ID
    },
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })],
      'wt-2': [makeTab({ id: GRID_TAB_ID, worktreeId: 'wt-2' })]
    }
  }

  it('scans the floating tab alongside the main tab while the panel is visible', () => {
    expect(resolveAutoAckTabTargets(baseState, { floatingPanelVisible: true })).toEqual([
      { tabId: FLOATING_TAB_ID, worktreeId: FLOATING_TERMINAL_WORKTREE_ID },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    ])
  })

  it('skips the floating tab while the panel is closed', () => {
    expect(resolveAutoAckTabTargets(baseState, { floatingPanelVisible: false })).toEqual([
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    ])
  })

  it('scans the floating tab outside the terminal view because the panel overlays every view', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...baseState, activeView: 'activity' },
        { floatingPanelVisible: true }
      )
    ).toEqual([{ tabId: FLOATING_TAB_ID, worktreeId: FLOATING_TERMINAL_WORKTREE_ID }])
  })

  it('scans nothing outside the terminal view with the panel closed', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...baseState, activeView: 'activity' },
        { floatingPanelVisible: false }
      )
    ).toEqual([])
  })

  it('prefers the visible floating worktree when both worktrees claim one tab id', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...baseState, activeTabId: FLOATING_TAB_ID },
        { floatingPanelVisible: true }
      )
    ).toEqual([{ tabId: FLOATING_TAB_ID, worktreeId: FLOATING_TERMINAL_WORKTREE_ID }])
  })

  // The grid lists every workspace, so the selected card's worktree is the one that owns
  // the tab — not `activeWorktreeId`, which is whatever the sidebar last pointed at.
  it('scans the selected grid card in the sessions view, under its own worktree', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...baseState, activeView: 'sessions', activeSessionGridTabId: GRID_TAB_ID },
        { floatingPanelVisible: false }
      )
    ).toEqual([{ tabId: GRID_TAB_ID, worktreeId: 'wt-2' }])
  })

  // Opening the grid must not ack anything on its own: nine cards on screen are nine
  // turns across five surfaces, and none of them has been looked at yet.
  it('scans nothing in the sessions view until a card is selected', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...baseState, activeView: 'sessions', activeSessionGridTabId: null },
        { floatingPanelVisible: false }
      )
    ).toEqual([])
  })

  it('leaves the grid selection alone while the terminal view is on screen', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...baseState, activeSessionGridTabId: GRID_TAB_ID },
        { floatingPanelVisible: false }
      )
    ).toEqual([{ tabId: 'tab-1', worktreeId: 'wt-1' }])
  })

  /**
   * A sighting is a card the grid is SHOWING, not an id the store still remembers. Being in
   * `tabsByWorktree` is not enough: the card can have been hidden, filtered out, or closed
   * since it was picked, and acking it there clears its signal on five surfaces for a turn
   * nobody saw. This is membership, not viewport awareness — scroll position is deliberately
   * not consulted.
   */
  const gridState = { ...baseState, activeView: 'sessions', activeSessionGridTabId: GRID_TAB_ID }

  it('skips a selection whose card the workspace filter has taken off the board', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...gridState, sessionsGridFilter: 'wt-1' },
        { floatingPanelVisible: false }
      )
    ).toEqual([])
  })

  it('scans it again under a workspace filter that does show it', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...gridState, sessionsGridFilter: 'wt-2' },
        { floatingPanelVisible: false }
      )
    ).toEqual([{ tabId: GRID_TAB_ID, worktreeId: 'wt-2' }])
  })

  // A workspace filter naming somewhere with no sessions is not a filter the grid applies.
  it('ignores a workspace filter no open session answers to', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...gridState, sessionsGridFilter: 'wt-gone' },
        { floatingPanelVisible: false }
      )
    ).toEqual([{ tabId: GRID_TAB_ID, worktreeId: 'wt-2' }])
  })

  it('skips a selection the user hid from the grid', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...gridState, sessionsGridHiddenTabIds: [GRID_TAB_ID] },
        { floatingPanelVisible: false }
      )
    ).toEqual([])
  })

  it('skips a selection whose tab has since been closed', () => {
    expect(
      resolveAutoAckTabTargets(
        { ...gridState, tabsByWorktree: { 'wt-1': baseState.tabsByWorktree['wt-1'] } },
        { floatingPanelVisible: false }
      )
    ).toEqual([])
  })
})

// Why: the minimized toggle's attention dot is the only signal a closed floating panel has, so a
// hidden panel must never auto-ack (selectFloatingWorkspaceHasUnread → FloatingTerminalToggleButton).
describe('floating workspace auto-ack against the attention dot', () => {
  const FLOATING_TAB_ID = 'tab-floating'
  const floatingPaneKey = makePaneKey(FLOATING_TAB_ID, CODEX_LEAF_ID)

  function seedFloatingCompletion(): ReturnType<typeof createTestStore> {
    const store = createTestStore()
    store.setState({
      activeView: 'terminal',
      activeTabId: 'tab-1',
      activeWorktreeId: 'wt-1',
      activeTabIdByWorktree: {
        'wt-1': 'tab-1',
        [FLOATING_TERMINAL_WORKTREE_ID]: FLOATING_TAB_ID
      },
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })],
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeTab({ id: FLOATING_TAB_ID, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
        ]
      }
    })
    store.getState().markAgentCompletionPaneUnread(floatingPaneKey, 'agent-completion')
    return store
  }

  function runAutoAckScan(store: TestStore, floatingPanelVisible: boolean): void {
    const state = store.getState()
    for (const target of resolveAutoAckTabTargets(state, { floatingPanelVisible })) {
      const current = store.getState()
      const surface = createTerminalAttentionSurface(current)
      const viewedUnreadSubjectKey = resolveViewedUnreadSubjectKey(
        current.unreadAgentCompletionPanes,
        makePaneKey(target.tabId, CODEX_LEAF_ID)
      )
      const clearedSubjectKeys = new Set(viewedUnreadSubjectKey ? [viewedUnreadSubjectKey] : [])
      const workspaceId = target.worktreeId
      applyAgentAttentionAcknowledgement(
        {
          acknowledgeSubjects: current.acknowledgeAgents,
          clearWorkspaceUnread: current.clearWorktreeUnread,
          clearGroupUnread: current.clearTerminalTabUnread,
          clearSubjectUnread: current.clearTerminalPaneUnread
        },
        {
          workspaceIdToClear:
            workspaceId !== null &&
            shouldClearWorkspaceAttention(surface.collectWorkspaceAttentionRemainder(workspaceId), {
              viewedGroupId: target.tabId,
              clearedSubjectKeys
            })
              ? workspaceId
              : null,
          viewedGroupId: target.tabId,
          subjectKeys: [],
          viewedUnreadSubjectKey
        }
      )
    }
  }

  it('keeps the attention dot lit while the panel is closed', () => {
    const store = seedFloatingCompletion()
    expect(selectFloatingWorkspaceHasUnread(store.getState())).toBe(true)

    runAutoAckScan(store, false)

    expect(selectFloatingWorkspaceHasUnread(store.getState())).toBe(true)
  })

  it('clears the attention dot once the panel is visible', () => {
    const store = seedFloatingCompletion()

    runAutoAckScan(store, true)

    expect(selectFloatingWorkspaceHasUnread(store.getState())).toBe(false)
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
