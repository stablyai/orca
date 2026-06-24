import { describe, expect, it } from 'vitest'
import {
  selectOrchestrationActivityForTabs,
  selectRunDagForTabs,
  selectSpawnedWorktreeIds
} from './orchestrator-mission-control-data'
import type { WorktreeLineage } from '../../../shared/types'
import type { OrchestrationRunDag } from '../../../shared/runtime-types'

function lineage(
  over: Partial<WorktreeLineage> & Pick<WorktreeLineage, 'worktreeId'>
): WorktreeLineage {
  return {
    worktreeInstanceId: `${over.worktreeId}-inst`,
    parentWorktreeId: 'director',
    parentWorktreeInstanceId: 'director-inst',
    origin: 'orchestration',
    capture: { source: 'cwd-context', confidence: 'explicit' },
    createdAt: 0,
    ...over
  }
}

const byId = (entries: WorktreeLineage[]): Record<string, WorktreeLineage> =>
  Object.fromEntries(entries.map((entry) => [entry.worktreeId, entry]))

describe('selectSpawnedWorktreeIds', () => {
  it('returns only worktrees whose lineage parent is the director, oldest first', () => {
    const map = byId([
      lineage({ worktreeId: 'w2', createdAt: 200 }),
      lineage({ worktreeId: 'w1', createdAt: 100 }),
      lineage({ worktreeId: 'other', parentWorktreeId: 'someone-else', createdAt: 150 })
    ])
    expect(selectSpawnedWorktreeIds('director', map, () => true)).toEqual(['w1', 'w2'])
  })

  it('drops worktrees that are no longer live', () => {
    const map = byId([
      lineage({ worktreeId: 'w1', createdAt: 100 }),
      lineage({ worktreeId: 'w2', createdAt: 200 })
    ])
    const live = new Set(['w1'])
    expect(selectSpawnedWorktreeIds('director', map, (id) => live.has(id))).toEqual(['w1'])
  })

  it('returns an empty list when the director has spawned nothing', () => {
    const map = byId([lineage({ worktreeId: 'w1', parentWorktreeId: 'another-director' })])
    expect(selectSpawnedWorktreeIds('director', map, () => true)).toEqual([])
  })

  // Why (F2 #13): the consumer half of the bridge. The coordinator's
  // createWorktree records lineage with origin 'orchestration', capture source
  // 'orchestration-context', and parentWorktreeId = the director worktree.
  // This asserts Mission Control's selector discovers such a worker with no MC
  // change — the producing half (coordinator emits this edge) is asserted in
  // src/main/runtime/orchestration/coordinator.test.ts.
  it('discovers a coordinator-created worktree-backed worker (F2 bridge)', () => {
    const directorWorktreeId = 'director-wt'
    const map = byId([
      {
        worktreeId: 'wt_child_0',
        worktreeInstanceId: 'wt_child_0-inst',
        parentWorktreeId: directorWorktreeId,
        parentWorktreeInstanceId: `${directorWorktreeId}-inst`,
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'explicit' },
        orchestrationRunId: 'run_abc',
        taskId: 'task_abc',
        coordinatorHandle: 'coordinator-deadbeef',
        createdAt: 0
      }
    ])
    expect(selectSpawnedWorktreeIds(directorWorktreeId, map, () => true)).toEqual(['wt_child_0'])
  })
})

function dag(runId: string): OrchestrationRunDag {
  return { runId, recipe: null, tasks: [], truncatedTaskCount: 0 }
}

describe('selectRunDagForTabs (#7 — per-run scoping)', () => {
  // paneKey is `${tabId}:${leafId}`; a director only sees the DAG whose
  // coordinator pane lives in one of its own tabs.
  const byPaneKey = {
    'tab_a:leaf_1': dag('run_a'),
    'tab_b:leaf_1': dag('run_b')
  }

  it('returns the DAG for a director tab and nothing for an unrelated director', () => {
    expect(selectRunDagForTabs(['tab_a'], byPaneKey)?.runId).toBe('run_a')
    expect(selectRunDagForTabs(['tab_b'], byPaneKey)?.runId).toBe('run_b')
    expect(selectRunDagForTabs(['tab_c'], byPaneKey)).toBeNull()
  })

  it('two concurrent runs do not bleed across directors', () => {
    // Director A's tabs must never resolve director B's run.
    expect(selectRunDagForTabs(['tab_a'], byPaneKey)?.runId).not.toBe('run_b')
  })
})

describe('selectOrchestrationActivityForTabs', () => {
  it('matches activity by the coordinator paneKey tab id', () => {
    const activity = {
      'tab_a:leaf_1': { runId: 'run_a', pendingTasks: 3, activeDispatches: 2, staleDispatches: 1 }
    }
    expect(selectOrchestrationActivityForTabs(['tab_a'], activity)?.pendingTasks).toBe(3)
    expect(selectOrchestrationActivityForTabs(['tab_z'], activity)).toBeNull()
  })
})
