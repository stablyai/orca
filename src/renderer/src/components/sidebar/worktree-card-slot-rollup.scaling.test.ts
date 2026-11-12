// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as ProjectionModule from './workspace-card/activity/worktree-agent-rows-projection'
import type * as RowsModule from './workspace-card/activity/worktree-agent-rows'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineageRange } from '../../../../shared/sidebar-list/worktree-lineage-range'
import type { Worktree } from '../../../../shared/worktree/types'
import { selectCollapsedLineageSlots, selectLineageLatestAt } from './worktree-card-slot-rollup'
import { getSharedWorktreeAgentRowsSelector } from './workspace-card/activity/worktree-agent-rows-projection'

const counts = vi.hoisted(() => ({
  selectorKeys: new Set<string>(),
  selectorReads: 0,
  builds: 0
}))
vi.mock('./workspace-card/activity/worktree-agent-rows-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectionModule>()
  return {
    ...actual,
    getSharedWorktreeAgentRowsSelector: (
      ...args: Parameters<typeof actual.getSharedWorktreeAgentRowsSelector>
    ) => {
      counts.selectorKeys.add(`${args[1]}\n${args[0]}`)
      const select = actual.getSharedWorktreeAgentRowsSelector(...args)
      return (state: Parameters<typeof select>[0]) => {
        counts.selectorReads++
        return select(state)
      }
    }
  }
})
vi.mock('./workspace-card/activity/worktree-agent-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof RowsModule>()
  return {
    ...actual,
    buildWorktreeAgentRows: (...args: Parameters<typeof actual.buildWorktreeAgentRows>) => {
      counts.builds++
      return actual.buildWorktreeAgentRows(...args)
    }
  }
})

const original = useAppStore.getState()
const LEAF = '11111111-1111-4111-8111-111111111111'

function resetCounts(): void {
  counts.selectorKeys.clear()
  counts.selectorReads = 0
  counts.builds = 0
}

/** One parent with one child, then `siblings` unrelated roots in the same section. */
function seedSection(siblings: number): { range: WorktreeLineageRange; rows: Worktree[] } {
  const rows = Array.from({ length: siblings + 2 }, (_, i) =>
    makeWorktree({
      id: `${TEST_REPO.id}::/s${siblings}-w${i}`,
      repoId: TEST_REPO.id,
      hostId: 'local'
    })
  )
  useAppStore.setState({ worktreesByRepo: { [TEST_REPO.id]: rows } })
  const tree = {
    identities: rows.map(getWorktreeHostIdentity),
    worktrees: rows,
    ends: rows.map((_, i) => (i === 0 ? 2 : i + 1))
  }
  return { range: { tree, index: 0, length: 1 }, rows }
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
  resetCounts()
})
afterEach(() => {
  useAppStore.setState(original, true)
  vi.useRealTimers()
})

describe.each([10, 100])('lineage rollup in a section with %i unrelated siblings', (siblings) => {
  it('projects only the nested workspace on mount', () => {
    const { range } = seedSection(siblings)
    readParent(range)
    expect(counts.selectorKeys.size).toBe(1)
    expect(counts.builds).toBe(1)
  })

  it('does no per-workspace work when the active workspace changes', () => {
    const { range, rows } = seedSection(siblings)
    readParent(range)
    resetCounts()
    useAppStore.setState({ activeWorktreeId: rows[5]!.id, activeWorkspaceExecutionHostId: 'local' })
    readParent(range)
    expect(counts.selectorReads).toBe(0)
  })

  it('re-projects only the child when a catalog row changes', () => {
    const { range, rows } = seedSection(siblings)
    readParent(range)
    resetCounts()
    const sibling = { ...rows[3]!, lastActivityAt: 5 }
    useAppStore.setState({
      worktreesByRepo: { [TEST_REPO.id]: rows.map((row, i) => (i === 3 ? sibling : row)) }
    })
    readParent(range)
    expect(counts.selectorReads).toBe(0)

    const latest = useAppStore.getState().worktreesByRepo[TEST_REPO.id]!
    useAppStore.setState({
      worktreesByRepo: {
        [TEST_REPO.id]: latest.map((row, i) =>
          i === 1 ? { ...row, lastActivityAt: 1_500_000 } : row
        )
      }
    })
    expect(selectLineageLatestAt(useAppStore.getState(), range)).toBe(1_500_000)
    expect(counts.selectorReads).toBe(1)
  })

  it('shares the child card’s row projection with the rollup', () => {
    const { range, rows } = seedSection(siblings)
    readParent(range)
    resetCounts()
    // What the mounted child card's useWorktreeAgentRows reads on the live store.
    const ownRows = getSharedWorktreeAgentRowsSelector(rows[1]!.id, 'local')
    expect(ownRows(useAppStore.getState())).toEqual([])
    expect(counts.builds).toBe(0)
  })

  it('ignores agent activity in sibling workspaces', () => {
    const { range, rows } = seedSection(siblings)
    readParent(range)
    resetCounts()
    const paneKey = makePaneKey('sibling-tab', LEAF)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          worktreeId: rows[4]!.id,
          state: 'working',
          agentType: 'claude',
          prompt: '',
          updatedAt: 2_000_000,
          stateStartedAt: 1_900_000,
          stateHistory: []
        }
      }
    })
    readParent(range)
    expect(counts.selectorReads).toBe(0)
    expect(counts.builds).toBe(0)
  })
})
