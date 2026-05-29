import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  buildWorktreeAgentRows,
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree
} from './useWorktreeAgentRows'
import { applyAgentRowLineage } from '@/components/dashboard/agent-row-lineage'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const ORPHAN_PANE_KEY = makePaneKey('tab-orphan', '11111111-1111-4111-8111-111111111111')
const PANE_KEY_1 = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')
const PANE_KEY_2 = makePaneKey('tab-2', '33333333-3333-4333-8333-333333333333')
const PANE_KEY_3 = makePaneKey('tab-3', '55555555-5555-4555-8555-555555555555')
const PANE_KEY_4 = makePaneKey('tab-4', '66666666-6666-4666-8666-666666666666')

function makeTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeEntry(
  paneKey: string,
  startedAt: number,
  overrides?: Partial<AgentStatusEntry>
): AgentStatusEntry {
  return {
    paneKey,
    state: 'done',
    stateStartedAt: startedAt,
    updatedAt: startedAt,
    stateHistory: [],
    prompt: 'finished prompt',
    agentType: 'claude',
    terminalTitle: undefined,
    interrupted: false,
    ...overrides
  }
}

function makeRetained(paneKey: string, worktreeId: string, startedAt: number): RetainedAgentEntry {
  return {
    entry: makeEntry(paneKey, startedAt),
    worktreeId,
    tab: makeTab(paneKey.slice(0, paneKey.indexOf(':'))),
    agentType: 'claude',
    startedAt
  }
}

describe('buildWorktreeAgentRows', () => {
  it('includes retained rows even when their original tab is no longer current', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [],
      // Why: useWorktreeAgentRows filters retained snapshots by worktreeId, not
      // current tab membership. This is the sidebar behavior that sleep cleanup
      // must counter by dropping worktree-scoped retained rows.
      retained: [makeRetained(ORPHAN_PANE_KEY, 'wt-1', 1000)],
      now: 2000
    })

    expect(rows.map((row) => row.paneKey)).toEqual([ORPHAN_PANE_KEY])
    expect(rows[0].state).toBe('done')
  })

  it('prefers a live row over a retained snapshot with the same paneKey', () => {
    const liveEntry = makeEntry(PANE_KEY_1, 2000)
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [liveEntry],
      retained: [makeRetained(PANE_KEY_1, 'wt-1', 1000)],
      now: 3000
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].entry).toBe(liveEntry)
    expect(rows[0].startedAt).toBe(2000)
  })

  it('decays a stale working entry to idle but leaves a stale done entry alone', () => {
    // Why: the freshness scheduler ticks agentStatusEpoch when an entry crosses
    // the stale boundary; the row state machine must collapse working/blocked/
    // waiting to idle but preserve done. Sleep is the most common path that
    // freezes hook entries past their TTL.
    const staleAt = 1000
    const freshDoneAt = 2000
    const now = staleAt + AGENT_STATUS_STALE_AFTER_MS + 1
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1'), makeTab('tab-2')],
      entries: [
        makeEntry(PANE_KEY_1, staleAt, { state: 'working', updatedAt: staleAt }),
        makeEntry(PANE_KEY_2, freshDoneAt, { state: 'done', updatedAt: freshDoneAt })
      ],
      retained: [],
      now
    })

    const working = rows.find((r) => r.paneKey === PANE_KEY_1)
    const done = rows.find((r) => r.paneKey === PANE_KEY_2)
    expect(working?.state).toBe('idle')
    expect(done?.state).toBe('done')
  })
})

describe('applyAgentRowLineage', () => {
  it('places orchestration children immediately after their parent', () => {
    const parent = makeEntry(PANE_KEY_2, 2000, {
      prompt: 'parent'
    })
    const firstChild = makeEntry(PANE_KEY_1, 1000, {
      prompt: 'first child',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentTerminalHandle: 'term-parent',
        parentPaneKey: PANE_KEY_2
      }
    })
    const secondChild = makeEntry(PANE_KEY_3, 3000, {
      prompt: 'second child',
      orchestration: {
        taskId: 'task-2',
        dispatchId: 'ctx-2',
        parentTerminalHandle: 'term-parent',
        parentPaneKey: PANE_KEY_2
      }
    })

    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1'), makeTab('tab-2'), makeTab('tab-3')],
      entries: [firstChild, parent, secondChild],
      retained: [],
      now: 4000
    })
    const ordered = applyAgentRowLineage(rows)

    expect(ordered.map((row) => row.paneKey)).toEqual([PANE_KEY_2, PANE_KEY_1, PANE_KEY_3])
    expect(ordered[0].lineage).toMatchObject({ depth: 0, childCount: 2 })
    expect(ordered[1].lineage).toMatchObject({
      depth: 1,
      isFirstSibling: true,
      isLastSibling: false
    })
    expect(ordered[2].lineage).toMatchObject({
      depth: 1,
      isFirstSibling: false,
      isLastSibling: true
    })
  })

  it('leaves orphan orchestration rows flat when the parent pane is not visible', () => {
    const child = makeEntry(PANE_KEY_1, 1000, {
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentTerminalHandle: 'term-missing',
        parentPaneKey: PANE_KEY_2
      }
    })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [child],
      retained: [],
      now: 2000
    })

    expect(applyAgentRowLineage(rows)[0].lineage).toMatchObject({ depth: 0, childCount: 0 })
  })

  it('keeps nested dispatches under their nearest visible parent', () => {
    const parent = makeEntry(PANE_KEY_1, 1000, { prompt: 'parent' })
    const child = makeEntry(PANE_KEY_2, 2000, {
      prompt: 'child',
      orchestration: {
        taskId: 'task-child',
        dispatchId: 'ctx-child',
        parentPaneKey: PANE_KEY_1
      }
    })
    const grandchild = makeEntry(PANE_KEY_3, 3000, {
      prompt: 'grandchild',
      orchestration: {
        taskId: 'task-grandchild',
        dispatchId: 'ctx-grandchild',
        parentPaneKey: PANE_KEY_2
      }
    })
    const sibling = makeEntry(PANE_KEY_4, 4000, { prompt: 'sibling root' })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1'), makeTab('tab-2'), makeTab('tab-3'), makeTab('tab-4')],
      entries: [parent, child, grandchild, sibling],
      retained: [],
      now: 5000
    })

    const ordered = applyAgentRowLineage(rows)

    expect(ordered.map((row) => row.paneKey)).toEqual([
      PANE_KEY_1,
      PANE_KEY_2,
      PANE_KEY_3,
      PANE_KEY_4
    ])
    expect(ordered[1].lineage).toMatchObject({ depth: 1, childCount: 1 })
    expect(ordered[2].lineage).toMatchObject({ depth: 1, childCount: 0 })
  })
})

describe('selectMigrationUnsupportedEntriesForWorktree', () => {
  it('returns raw migration records so shallow selectors can cache snapshots', () => {
    const unsupported: MigrationUnsupportedPtyEntry = {
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: '44444444-4444-4444-8444-444444444444',
      paneKey: makePaneKey('tab-1', '44444444-4444-4444-8444-444444444444'),
      reason: 'legacy-numeric-pane-key',
      source: 'local',
      updatedAt: 1000
    }
    const state = {
      tabsByWorktree: { 'wt-1': [makeTab('tab-1')] },
      agentStatusByPaneKey: {},
      migrationUnsupportedByPtyId: { 'pty-1': unsupported },
      retainedAgentsByPaneKey: {}
    }

    const first = selectMigrationUnsupportedEntriesForWorktree(state, 'wt-1')
    const second = selectMigrationUnsupportedEntriesForWorktree(state, 'wt-1')

    // Why: the Electron black-screen regression came from creating converted
    // AgentStatusEntry objects inside the Zustand selector. Returning store
    // records preserves element identity for useShallow.
    expect(first).toEqual([unsupported])
    expect(second).toEqual([unsupported])
    expect(first).toBe(second)
    expect(first[0]).toBe(second[0])
  })
})

describe('selectLiveAgentStatusEntriesForWorktree', () => {
  it('reuses unaffected worktree arrays when another worktree receives a same-state ping', () => {
    const wt1Entry = makeEntry(PANE_KEY_1, 1000, { state: 'working', prompt: 'first' })
    const wt2Entry = makeEntry(PANE_KEY_2, 1000, { state: 'working', prompt: 'first' })
    const state = {
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1')],
        'wt-2': [makeTab('tab-2')]
      },
      agentStatusByPaneKey: {
        [PANE_KEY_1]: wt1Entry,
        [PANE_KEY_2]: wt2Entry
      },
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }

    const firstWt1 = selectLiveAgentStatusEntriesForWorktree(state, 'wt-1')
    const firstWt2 = selectLiveAgentStatusEntriesForWorktree(state, 'wt-2')
    const nextState = {
      ...state,
      agentStatusByPaneKey: {
        [PANE_KEY_1]: wt1Entry,
        [PANE_KEY_2]: {
          ...wt2Entry,
          prompt: 'updated prompt preview',
          updatedAt: 1100
        }
      }
    }

    const secondWt1 = selectLiveAgentStatusEntriesForWorktree(nextState, 'wt-1')
    const secondWt2 = selectLiveAgentStatusEntriesForWorktree(nextState, 'wt-2')

    // Why: WorktreeCard mounts one selector per visible card. A same-state
    // hook ping for wt-2 must not make wt-1 pay a fresh array/render cost.
    expect(secondWt1).toBe(firstWt1)
    expect(secondWt2).not.toBe(firstWt2)
    expect(secondWt2[0]?.prompt).toBe('updated prompt preview')
  })
})

describe('selectRetainedAgentEntriesForWorktree', () => {
  it('reuses unaffected worktree arrays when another worktree retained row changes', () => {
    const wt1Retained = makeRetained(PANE_KEY_1, 'wt-1', 1000)
    const wt2Retained = makeRetained(PANE_KEY_2, 'wt-2', 1000)
    const state = {
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {
        [PANE_KEY_1]: wt1Retained,
        [PANE_KEY_2]: wt2Retained
      }
    }

    const firstWt1 = selectRetainedAgentEntriesForWorktree(state, 'wt-1')
    const firstWt2 = selectRetainedAgentEntriesForWorktree(state, 'wt-2')
    const nextState = {
      ...state,
      retainedAgentsByPaneKey: {
        [PANE_KEY_1]: wt1Retained,
        [PANE_KEY_2]: {
          ...wt2Retained,
          startedAt: 1100
        }
      }
    }

    const secondWt1 = selectRetainedAgentEntriesForWorktree(nextState, 'wt-1')
    const secondWt2 = selectRetainedAgentEntriesForWorktree(nextState, 'wt-2')

    expect(secondWt1).toBe(firstWt1)
    expect(secondWt2).not.toBe(firstWt2)
    expect(secondWt2[0]?.startedAt).toBe(1100)
  })
})
