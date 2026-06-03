/* eslint-disable max-lines -- Why: this suite covers one row-building seam
   shared by retention, stale decay, and orchestration lineage regressions. */
import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { applyAgentRowLineage } from '@/components/dashboard/agent-row-lineage'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const ORPHAN_PANE_KEY = makePaneKey('tab-orphan', '11111111-1111-4111-8111-111111111111')
const LEAF_ID_1 = '22222222-2222-4222-8222-222222222222'
const LEAF_ID_1_SECOND = '77777777-7777-4777-8777-777777777777'
const PANE_KEY_1 = makePaneKey('tab-1', LEAF_ID_1)
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

function makeSinglePaneLayout(leafId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null
  }
}

function makeSplitPaneLayout(firstLeafId: string, secondLeafId: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: firstLeafId },
      second: { type: 'leaf', leafId: secondLeafId }
    },
    activeLeafId: firstLeafId,
    expandedLeafId: null
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

  it('dedupes retained legacy numeric rows for a single current stable pane', () => {
    const liveEntry = makeEntry(PANE_KEY_1, 2000, {
      state: 'working',
      agentType: 'copilot',
      prompt: 'current turn'
    })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [liveEntry],
      retained: [makeRetained('tab-1:1', 'wt-1', 1000), makeRetained('tab-1:2', 'wt-1', 1500)],
      terminalLayoutsByTabId: {
        'tab-1': makeSinglePaneLayout(LEAF_ID_1)
      },
      now: 3000
    })

    expect(rows.map((row) => row.paneKey)).toEqual([PANE_KEY_1])
  })

  it('keeps a retained legacy numeric row for a different split pane', () => {
    const liveEntry = makeEntry(PANE_KEY_1, 2000, {
      state: 'working',
      agentType: 'copilot',
      prompt: 'current turn'
    })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1')],
      entries: [liveEntry],
      retained: [makeRetained('tab-1:1', 'wt-1', 1000), makeRetained('tab-1:2', 'wt-1', 1500)],
      terminalLayoutsByTabId: {
        'tab-1': makeSplitPaneLayout(LEAF_ID_1, LEAF_ID_1_SECOND)
      },
      now: 3000
    })

    expect(rows.map((row) => row.paneKey)).toEqual(['tab-1:2', PANE_KEY_1])
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

  it('renders live worktree-attributed entries even when their tab is absent', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [],
      entries: [
        makeEntry(PANE_KEY_1, 1000, {
          state: 'working',
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          prompt: 'child agent'
        })
      ],
      retained: [],
      now: 2000
    })

    expect(rows.map((row) => row.paneKey)).toEqual([PANE_KEY_1])
    expect(rows[0]).toMatchObject({
      state: 'working',
      tab: {
        id: 'tab-1',
        worktreeId: 'wt-1'
      }
    })
  })

  it('uses runtime orchestration metadata for hook-reported live rows', () => {
    const parent = makeEntry(PANE_KEY_1, 1000, {
      prompt: 'parent',
      state: 'working'
    })
    const child = makeEntry(PANE_KEY_2, 1200, {
      prompt: 'child',
      state: 'working'
    })
    const rows = applyAgentRowLineage(
      buildWorktreeAgentRows({
        tabs: [makeTab('tab-1'), makeTab('tab-2')],
        entries: [parent, child],
        retained: [],
        runtimeAgentOrchestrationByPaneKey: {
          [PANE_KEY_2]: {
            taskId: 'task-1',
            dispatchId: 'ctx-1',
            parentPaneKey: PANE_KEY_1
          }
        },
        now: 2000
      })
    )

    expect(rows.map((row) => row.paneKey)).toEqual([PANE_KEY_1, PANE_KEY_2])
    expect(rows[0].lineage).toMatchObject({ depth: 0, childCount: 1 })
    expect(rows[1].lineage).toMatchObject({ depth: 1, childCount: 0 })
    expect(rows[1].entry.orchestration).toMatchObject({ parentPaneKey: PANE_KEY_1 })
  })

  it('does not override current hook dispatch identity with mismatched runtime metadata', () => {
    const currentParent = makeEntry(PANE_KEY_1, 1000, {
      prompt: 'current parent',
      state: 'done'
    })
    const staleParent = makeEntry(PANE_KEY_3, 1100, {
      prompt: 'stale parent',
      state: 'working'
    })
    const child = makeEntry(PANE_KEY_2, 1200, {
      prompt: 'child',
      state: 'working',
      orchestration: {
        taskId: 'task-2',
        dispatchId: 'ctx-2',
        parentPaneKey: PANE_KEY_1,
        parentTerminalHandle: 'term-current'
      }
    })
    const rows = applyAgentRowLineage(
      buildWorktreeAgentRows({
        tabs: [makeTab('tab-1'), makeTab('tab-2'), makeTab('tab-3')],
        entries: [currentParent, staleParent, child],
        retained: [],
        runtimeAgentOrchestrationByPaneKey: {
          [PANE_KEY_2]: {
            taskId: 'task-1',
            dispatchId: 'ctx-1',
            parentPaneKey: PANE_KEY_3,
            parentTerminalHandle: 'term-stale'
          }
        },
        now: 2000
      })
    )

    expect(rows.map((row) => row.paneKey)).toEqual([PANE_KEY_1, PANE_KEY_2, PANE_KEY_3])
    expect(rows[0].lineage).toMatchObject({ depth: 0, childCount: 1 })
    expect(rows[1].lineage).toMatchObject({ depth: 1, childCount: 0 })
    expect(rows[1].entry.orchestration).toEqual({
      taskId: 'task-2',
      dispatchId: 'ctx-2',
      parentPaneKey: PANE_KEY_1,
      parentTerminalHandle: 'term-current'
    })
  })

  it('uses runtime orchestration metadata for retained child rows', () => {
    const parent = makeEntry(PANE_KEY_1, 1000, {
      prompt: 'parent',
      state: 'done'
    })
    const retainedChild = makeRetained(PANE_KEY_2, 'wt-1', 1200)
    const rows = applyAgentRowLineage(
      buildWorktreeAgentRows({
        tabs: [makeTab('tab-1')],
        entries: [parent],
        retained: [retainedChild],
        runtimeAgentOrchestrationByPaneKey: {
          [PANE_KEY_2]: {
            taskId: 'task-1',
            dispatchId: 'ctx-1',
            parentPaneKey: PANE_KEY_1
          }
        },
        now: 2000
      })
    )

    expect(rows.map((row) => row.paneKey)).toEqual([PANE_KEY_1, PANE_KEY_2])
    expect(rows[0].lineage).toMatchObject({ depth: 0, childCount: 1 })
    expect(rows[1].lineage).toMatchObject({ depth: 1, childCount: 0 })
    expect(rows[1].entry.orchestration).toMatchObject({ parentPaneKey: PANE_KEY_1 })
  })

  it('groups child rows by parent terminal handle when parent pane key is missing', () => {
    const parent = makeEntry(PANE_KEY_1, 1000, {
      prompt: 'parent',
      state: 'done',
      terminalHandle: 'term-parent'
    })
    const child = makeEntry(PANE_KEY_2, 1200, {
      prompt: 'child',
      state: 'done',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentTerminalHandle: 'term-parent'
      }
    })
    const rows = applyAgentRowLineage(
      buildWorktreeAgentRows({
        tabs: [makeTab('tab-1'), makeTab('tab-2')],
        entries: [parent, child],
        retained: [],
        now: 2000
      })
    )

    expect(rows.map((row) => row.paneKey)).toEqual([PANE_KEY_1, PANE_KEY_2])
    expect(rows[0].lineage).toMatchObject({ depth: 0, childCount: 1 })
    expect(rows[1].lineage).toMatchObject({ depth: 1, childCount: 0 })
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
