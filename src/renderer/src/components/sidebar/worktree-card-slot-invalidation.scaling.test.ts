// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as ProjectionModule from './workspace-card/activity/worktree-agent-rows-projection'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineageRange } from '../../../../shared/sidebar-list/worktree-lineage-range'
import type { Worktree } from '../../../../shared/worktree/types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { selectCollapsedLineageSlots, selectLineageLatestAt } from './worktree-card-slot-rollup'
import { slotSnapshot } from './worktree-card-slot-invalidation'

// Counts per-workspace re-checks: each stale slot reads its workspace's row selector once.
const counts = vi.hoisted(() => ({ reads: [] as string[] }))
vi.mock('./workspace-card/activity/worktree-agent-rows-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectionModule>()
  return {
    ...actual,
    getSharedWorktreeAgentRowsSelector: (
      ...args: Parameters<typeof actual.getSharedWorktreeAgentRowsSelector>
    ) => {
      const select = actual.getSharedWorktreeAgentRowsSelector(...args)
      return (state: Parameters<typeof select>[0]) => {
        counts.reads.push(args[0])
        return select(state)
      }
    }
  }
})

const original = useAppStore.getState()
const LEAF = '11111111-1111-4111-8111-111111111111'

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function entry(paneKey: string, worktreeId: string): AgentStatusEntry {
  return {
    paneKey,
    worktreeId,
    state: 'done',
    agentType: 'claude',
    prompt: '',
    updatedAt: 2_000_000,
    stateStartedAt: 1_900_000,
    stateHistory: []
  }
}

/** A parent with `size` descendants, each owning one tab, then one unrelated root after them. */
function seedLineage(size: number): { range: WorktreeLineageRange; rows: Worktree[] } {
  const rows = Array.from({ length: size + 2 }, (_, i) =>
    makeWorktree({ id: `${TEST_REPO.id}::/l${size}-w${i}`, repoId: TEST_REPO.id, hostId: 'local' })
  )
  useAppStore.setState({
    worktreesByRepo: { [TEST_REPO.id]: rows },
    tabsByWorktree: Object.fromEntries(rows.map((row, i) => [row.id, [tab(`t${i}`, row.id)]]))
  })
  const tree = {
    identities: rows.map(getWorktreeHostIdentity),
    worktrees: rows,
    ends: rows.map((_, i) => (i === 0 ? size + 1 : i + 1))
  }
  return { range: { tree, index: 0, length: size }, rows }
}

function readParent(range: WorktreeLineageRange): void {
  const state = useAppStore.getState()
  selectCollapsedLineageSlots(state, range)
  selectLineageLatestAt(state, range)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(2_000_000)
  useAppStore.setState({
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    agentStatusEpoch: 1,
    retainedAgentsByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    repos: [TEST_REPO],
    activeWorktreeId: null
  })
  counts.reads = []
})
afterEach(() => {
  useAppStore.setState(original, true)
  vi.useRealTimers()
})

describe.each([10, 100, 1000])('layout invalidation under a parent of %i', (size) => {
  it('re-checks only the owner when one tab’s ptys or layout change', () => {
    const { range, rows } = seedLineage(size)
    readParent(range)
    counts.reads = []
    useAppStore.setState({ ptyIdsByTabId: { t3: ['pty-t3'] } })
    readParent(range)
    expect(counts.reads).toEqual([rows[3]!.id])

    counts.reads = []
    useAppStore.setState({
      terminalLayoutsByTabId: {
        t4: { root: null, activeLeafId: null, expandedLeafId: null }
      }
    })
    readParent(range)
    expect(counts.reads).toEqual([rows[4]!.id])
  })

  it('skips the lineage entirely for a change outside it', () => {
    const { range, rows } = seedLineage(size)
    readParent(range)
    counts.reads = []
    const outside = rows.length - 1
    useAppStore.setState({ ptyIdsByTabId: { [`t${outside}`]: ['pty-x'] } })
    readParent(range)
    expect(counts.reads).toEqual([])
  })

  it('re-checks only the owner when a tab is replaced in place', () => {
    const { range, rows } = seedLineage(size)
    readParent(range)
    counts.reads = []
    const tabs = useAppStore.getState().tabsByWorktree
    useAppStore.setState({
      tabsByWorktree: { ...tabs, [rows[2]!.id]: [{ ...tab('t2', rows[2]!.id), title: 'renamed' }] }
    })
    readParent(range)
    expect(counts.reads).toEqual([rows[2]!.id])
  })

  it('re-checks the old and new owner when a retained agent changes', () => {
    const { range, rows } = seedLineage(size)
    const paneKey = makePaneKey('gone-tab', LEAF)
    const retained = (worktreeId: string) => ({
      entry: entry(paneKey, worktreeId),
      worktreeId,
      tab: tab('gone-tab', worktreeId),
      agentType: 'claude' as const,
      startedAt: 1_900_000
    })
    useAppStore.setState({ retainedAgentsByPaneKey: { [paneKey]: retained(rows[1]!.id) } })
    readParent(range)
    counts.reads = []
    useAppStore.setState({ retainedAgentsByPaneKey: { [paneKey]: retained(rows[5]!.id) } })
    readParent(range)
    expect(new Set(counts.reads)).toEqual(new Set([rows[1]!.id, rows[5]!.id]))
  })

  it('still re-checks every descendant when a tab moves between workspaces', () => {
    const { range, rows } = seedLineage(size)
    readParent(range)
    counts.reads = []
    const tabs = useAppStore.getState().tabsByWorktree
    useAppStore.setState({
      tabsByWorktree: {
        ...tabs,
        [rows[2]!.id]: [],
        [rows[3]!.id]: [tab('t3', rows[3]!.id), tab('t2', rows[3]!.id)]
      }
    })
    readParent(range)
    expect(counts.reads).toHaveLength(size)
  })
})

describe('orchestration invalidation', () => {
  it('re-checks the parent pane’s workspace, not only the child’s', () => {
    const { range, rows } = seedLineage(10)
    const child = makePaneKey('t6', LEAF)
    const parent = makePaneKey('t2', LEAF)
    useAppStore.setState({ agentStatusByPaneKey: { [child]: entry(child, rows[6]!.id) } })
    readParent(range)
    counts.reads = []
    useAppStore.setState({
      runtimeAgentOrchestrationByPaneKey: {
        [child]: { taskId: 'task', dispatchId: 'dispatch', parentPaneKey: parent }
      }
    })
    readParent(range)
    expect(new Set(counts.reads)).toEqual(new Set([rows[2]!.id, rows[6]!.id]))
  })
})

describe.each([10, 100, 1000])('freshness invalidation under a parent of %i', (size) => {
  function working(paneKey: string, worktreeId: string, evidenceAt: number): AgentStatusEntry {
    return {
      ...entry(paneKey, worktreeId),
      state: 'working',
      updatedAt: evidenceAt,
      evidenceObservedAt: evidenceAt
    }
  }

  it('re-checks nothing on an epoch tick that leaves every agent fresh', () => {
    const { range, rows } = seedLineage(size)
    useAppStore.setState({
      agentStatusByPaneKey: Object.fromEntries(
        rows.map((row, i) => {
          const paneKey = makePaneKey(`t${i}`, LEAF)
          return [paneKey, working(paneKey, row.id, 2_000_000)]
        })
      )
    })
    readParent(range)
    counts.reads = []
    vi.setSystemTime(2_000_000 + 60_000)
    useAppStore.setState({ agentStatusEpoch: 2 })
    readParent(range)
    expect(counts.reads).toEqual([])
  })

  it('re-checks only the workspace whose agent went stale on an epoch tick', () => {
    const { range, rows } = seedLineage(size)
    const AGES = AGENT_STATUS_STALE_AFTER_MS
    useAppStore.setState({
      agentStatusByPaneKey: Object.fromEntries(
        rows.map((row, i) => {
          const paneKey = makePaneKey(`t${i}`, LEAF)
          // Only workspace 4's evidence is old enough to expire within the next minute.
          const evidenceAt = i === 4 ? 2_000_000 - AGES + 30_000 : 2_000_000
          return [paneKey, working(paneKey, row.id, evidenceAt)]
        })
      )
    })
    readParent(range)
    counts.reads = []
    vi.setSystemTime(2_000_000 + 60_000)
    useAppStore.setState({ agentStatusEpoch: 2 })
    readParent(range)
    expect(counts.reads).toEqual([rows[4]!.id])
  })
})

describe('journal', () => {
  it('combines several steps for a tree that skipped reads', () => {
    const { range, rows } = seedLineage(100)
    readParent(range)
    counts.reads = []
    for (const index of [3, 7, 9]) {
      useAppStore.setState({ ptyIdsByTabId: { [`t${index}`]: [`pty-${index}`] } })
      // Another reader advances the shared journal without this tree.
      slotSnapshot(useAppStore.getState())
    }
    readParent(range)
    expect(new Set(counts.reads)).toEqual(new Set([rows[3]!.id, rows[7]!.id, rows[9]!.id]))
  })
})
