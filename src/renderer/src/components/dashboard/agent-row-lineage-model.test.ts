import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { DashboardAgentRow } from './useDashboardData'
import { buildAgentRowLineageTree } from './agent-row-lineage-model'

function makeTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeRow(
  paneKey: string,
  options: {
    terminalHandle?: string
    parentPaneKey?: string
    parentTerminalHandle?: string
    coordinatorHandle?: string
  } = {}
): DashboardAgentRow {
  const orchestration =
    options.parentPaneKey || options.parentTerminalHandle || options.coordinatorHandle
      ? {
          taskId: `${paneKey}-task`,
          dispatchId: `${paneKey}-dispatch`,
          ...(options.parentPaneKey ? { parentPaneKey: options.parentPaneKey } : {}),
          ...(options.parentTerminalHandle
            ? { parentTerminalHandle: options.parentTerminalHandle }
            : {}),
          ...(options.coordinatorHandle ? { coordinatorHandle: options.coordinatorHandle } : {})
        }
      : undefined
  const entry: AgentStatusEntry = {
    paneKey,
    state: 'done',
    prompt: paneKey,
    updatedAt: 1000,
    stateStartedAt: 1000,
    stateHistory: [],
    agentType: 'codex',
    ...(options.terminalHandle ? { terminalHandle: options.terminalHandle } : {}),
    ...(orchestration ? { orchestration } : {})
  }

  return {
    paneKey,
    entry,
    tab: makeTab(paneKey.split(':')[0] ?? paneKey),
    agentType: 'codex',
    state: 'done',
    startedAt: 1000
  }
}

describe('buildAgentRowLineageTree', () => {
  it('groups children by explicit parent pane key', () => {
    const parent = makeRow('parent:1')
    const child = makeRow('child:1', { parentPaneKey: 'parent:1' })

    const tree = buildAgentRowLineageTree([parent, child])

    expect(tree.rootRows.map((row) => row.paneKey)).toEqual(['parent:1'])
    expect(tree.childrenByParentPaneKey.get('parent:1')?.map((row) => row.paneKey)).toEqual([
      'child:1'
    ])
  })

  it('falls back to the parent terminal handle when the parent pane key is absent', () => {
    const parent = makeRow('parent:1', { terminalHandle: 'term-parent' })
    const child = makeRow('child:1', { parentTerminalHandle: 'term-parent' })

    const tree = buildAgentRowLineageTree([parent, child])

    expect(tree.rootRows.map((row) => row.paneKey)).toEqual(['parent:1'])
    expect(tree.childrenByParentPaneKey.get('parent:1')?.map((row) => row.paneKey)).toEqual([
      'child:1'
    ])
  })

  it('uses the coordinator handle as the last visible parent fallback', () => {
    const parent = makeRow('parent:1', { terminalHandle: 'term-coordinator' })
    const child = makeRow('child:1', { coordinatorHandle: 'term-coordinator' })

    const tree = buildAgentRowLineageTree([parent, child])

    expect(tree.rootRows.map((row) => row.paneKey)).toEqual(['parent:1'])
    expect(tree.childrenByParentPaneKey.get('parent:1')?.map((row) => row.paneKey)).toEqual([
      'child:1'
    ])
  })

  it('nests by parent pane key when the parent handles are stale after a restart', () => {
    // Why: terminal handles are minted per process, so after an app restart the
    // persisted coordinator handle names no live row; the durable pane key must win.
    const parent = makeRow('parent:1', { terminalHandle: 'term-parent-reminted' })
    const child = makeRow('child:1', {
      parentPaneKey: 'parent:1',
      parentTerminalHandle: 'term-parent-stale',
      coordinatorHandle: 'term-parent-stale'
    })

    const tree = buildAgentRowLineageTree([parent, child])

    expect(tree.rootRows.map((row) => row.paneKey)).toEqual(['parent:1'])
    expect(tree.childrenByParentPaneKey.get('parent:1')?.map((row) => row.paneKey)).toEqual([
      'child:1'
    ])
    expect(tree.childPaneKeys.has('child:1')).toBe(true)
  })

  it('keeps a child as a root when its parent pane key names no visible row', () => {
    const unrelated = makeRow('other:1', { terminalHandle: 'term-other' })
    const orphan = makeRow('child:1', {
      parentPaneKey: 'parent-closed:1',
      coordinatorHandle: 'term-parent-stale'
    })

    const tree = buildAgentRowLineageTree([unrelated, orphan])

    expect(tree.rootRows.map((row) => row.paneKey)).toEqual(['other:1', 'child:1'])
    expect(tree.childrenByParentPaneKey.size).toBe(0)
  })

  it('keeps cyclic lineage rows visible as flat roots', () => {
    const root = makeRow('root:1')
    const firstCycleRow = makeRow('cycle-a:1', { parentPaneKey: 'cycle-b:1' })
    const secondCycleRow = makeRow('cycle-b:1', { parentPaneKey: 'cycle-a:1' })

    const tree = buildAgentRowLineageTree([root, firstCycleRow, secondCycleRow])

    expect(tree.rootRows.map((row) => row.paneKey)).toEqual(['root:1', 'cycle-a:1', 'cycle-b:1'])
    expect(tree.childrenByParentPaneKey.size).toBe(0)
    expect(tree.childPaneKeys.size).toBe(0)
  })
})

describe('lineage reachability traversal', () => {
  it('keeps set copying linear for deeply nested agents', () => {
    const rows = Array.from({ length: 300 }, (_, index) =>
      makeRow(`pane-${index}`, index ? { parentPaneKey: `pane-${index - 1}` } : {})
    )
    const NativeSet = Set
    let copiedValues = 0
    class MeasuredSet<T> extends NativeSet<T> {
      constructor(values?: Iterable<T> | null) {
        super(values)
        if (values) {
          copiedValues += this.size
        }
      }
    }
    let tree: ReturnType<typeof buildAgentRowLineageTree>
    vi.stubGlobal('Set', MeasuredSet)
    try {
      tree = buildAgentRowLineageTree(rows)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(tree.rootRows).toEqual([rows[0]])
    expect(tree.childPaneKeys.size).toBe(rows.length - 1)
    expect(tree.childrenByParentPaneKey.get('pane-298')).toEqual([rows[299]])
    expect(copiedValues).toBeLessThanOrEqual(rows.length)
  })

  it('terminates reachable cycles introduced by duplicate pane keys without changing edges', () => {
    const root = makeRow('root')
    const first = makeRow('first', { parentPaneKey: 'root' })
    const second = makeRow('second', { parentPaneKey: 'first' })
    const duplicate = makeRow('first', { parentPaneKey: 'second' })
    const tree = buildAgentRowLineageTree([root, first, second, duplicate])

    expect(tree.rootRows).toEqual([root])
    expect([...tree.childPaneKeys]).toEqual(['first', 'second'])
    expect([...tree.childrenByParentPaneKey]).toEqual([
      ['root', [first]],
      ['first', [second]],
      ['second', [duplicate]]
    ])
  })
})

describe('unreachable lineage cleanup', () => {
  it('bounds pane-key reads while flattening disconnected cycles', () => {
    let paneKeyReads = 0
    const root = makeRow('root')
    const cycles = Array.from({ length: 200 }, (_, index) => {
      const row = makeRow(`cycle-${index}`, { parentPaneKey: `cycle-${index ^ 1}` })
      Object.defineProperty(row, 'paneKey', {
        get() {
          paneKeyReads++
          return `cycle-${index}`
        }
      })
      return row
    })
    const tree = buildAgentRowLineageTree([root, ...cycles])
    const measuredReads = paneKeyReads
    expect(tree.rootRows).toEqual([root, ...cycles])
    expect(tree.childrenByParentPaneKey.size).toBe(0)
    expect(tree.childPaneKeys.size).toBe(0)
    expect(measuredReads).toBeLessThanOrEqual(cycles.length * 20)
  })

  it('preserves reachable edges and promotes the first disconnected duplicate in input order', () => {
    const root = makeRow('root')
    const child = makeRow('child', { parentPaneKey: 'root' })
    const first = makeRow('cycle-a', { parentPaneKey: 'cycle-b' })
    const second = makeRow('cycle-b', { parentPaneKey: 'cycle-a' })
    const duplicate = makeRow('cycle-a', { parentPaneKey: 'cycle-b' })
    const descendant = makeRow('descendant', { parentPaneKey: 'cycle-b' })
    const tree = buildAgentRowLineageTree([first, root, child, second, duplicate, descendant])

    expect(tree.rootRows).toEqual([root, first, second, descendant])
    expect(tree.rootRows[1]).toBe(first)
    expect([...tree.childrenByParentPaneKey]).toEqual([['root', [child]]])
    expect([...tree.childPaneKeys]).toEqual(['child'])
  })
})
