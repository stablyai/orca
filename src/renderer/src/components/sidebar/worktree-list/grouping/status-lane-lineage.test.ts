import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { WorkspaceStatus, Worktree } from '../../../../../../shared/worktree/types'
import { getWorkspaceStatusGroupKey } from '../../../../../../shared/workspace/status/workspace-statuses'
import { buildSidebarRowPlan } from './build-rows.test-fixture'
import { repoMap, worktree } from './worktree-list-groups-test-fixtures'

function row(id: string, workspaceStatus: WorkspaceStatus): Worktree {
  return { ...worktree, id, instanceId: `${id}-i`, path: `/tmp/${id}`, workspaceStatus }
}

function edge(child: string, parent: string): WorktreeLineage {
  return {
    worktreeId: child,
    worktreeInstanceId: `${child}-i`,
    parentWorktreeId: parent,
    parentWorktreeInstanceId: `${parent}-i`,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 0
  }
}

describe('workspace-status lanes', () => {
  it('lists every descendant in its root ancestor lane, whatever its own status', () => {
    const rows = [
      row('parent', 'todo'),
      row('child-a', 'in-progress'),
      row('child-b', 'completed'),
      row('grandchild', 'in-review'),
      row('unrelated', 'in-progress')
    ]
    const lineage = {
      'child-a': edge('child-a', 'parent'),
      'child-b': edge('child-b', 'parent'),
      grandchild: edge('grandchild', 'child-a')
    }
    const plan = buildSidebarRowPlan(
      'workspace-status',
      rows,
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      lineage,
      undefined,
      true
    )
    const idsIn = (status: WorkspaceStatus): string[] =>
      (plan.occurrencePlan.bySection.get(getWorkspaceStatusGroupKey(status)) ?? []).map(
        (occurrence) => occurrence.row.id
      )

    expect(idsIn('todo').sort()).toEqual(['child-a', 'child-b', 'grandchild', 'parent'])
    expect(idsIn('in-progress')).toEqual(['unrelated'])
    expect(idsIn('completed')).toEqual([])
    expect(idsIn('in-review')).toEqual([])
  })
})
