import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows.test-fixture'
import { getWorktreeLineageGroupKey } from '../../../../../../shared/sidebar-list/group-keys'

import { worktree, repoMap } from './worktree-list-groups-test-fixtures'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

describe('buildRows workspace lineage nesting', () => {
  type ResolvedLineageWorktree = Worktree & {
    lineage: WorktreeLineage | null
    workspaceLineage?: null
    parentWorktreeId?: string | null
  }

  const parent: Worktree = {
    ...worktree,
    id: 'wt-parent',
    instanceId: 'parent-instance',
    displayName: 'coordinator'
  }
  const child: Worktree = {
    ...worktree,
    id: 'wt-child',
    instanceId: 'child-instance',
    displayName: 'worker'
  }

  const lineage: WorktreeLineage = {
    worktreeId: child.id,
    worktreeInstanceId: 'child-instance',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: 'parent-instance',
    origin: 'cli',
    capture: { source: 'terminal-context', confidence: 'inferred' },
    createdAt: 1
  }

  it('keeps same-id parent and child lineages partitioned by host', () => {
    const parentA = { ...parent, hostId: 'local' as const }
    const childA = { ...child, hostId: 'local' as const, lineage }
    const parentB = {
      ...parent,
      hostId: 'ssh:host-b' as const,
      instanceId: 'parent-instance-b'
    }
    const lineageB = {
      ...lineage,
      worktreeInstanceId: 'child-instance-b',
      parentWorktreeInstanceId: 'parent-instance-b'
    }
    const childB = {
      ...child,
      hostId: 'ssh:host-b' as const,
      instanceId: 'child-instance-b',
      lineage: lineageB
    }
    const rows = buildRows(
      'none',
      [childA, parentA, childB, parentB],
      repoMap,
      null,
      new Set([getWorktreeLineageGroupKey(parentA)]),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [parent.id, parentA],
        [child.id, childA]
      ]),
      true
    )

    expect(
      rows
        .filter((row) => row.type === 'item')
        .map((row) => [row.worktree.hostId, row.worktree.id, row.depth, row.lineageCollapsed])
    ).toEqual([
      ['local', parent.id, 0, true],
      ['ssh:host-b', parent.id, 0, false],
      ['ssh:host-b', child.id, 1, undefined]
    ])
  })

  it('keeps the hydrated lineage side-map authoritative when inline metadata disagrees', () => {
    const otherParent = {
      ...parent,
      id: 'wt-other-parent',
      instanceId: 'other-parent-instance'
    }
    const hydratedLineage = {
      ...lineage,
      parentWorktreeId: otherParent.id,
      parentWorktreeInstanceId: otherParent.instanceId!
    }
    const resolvedChild: ResolvedLineageWorktree = {
      ...child,
      parentWorktreeId: parent.id,
      lineage
    }
    const rows = buildRows(
      'none',
      [resolvedChild, parent, otherParent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: hydratedLineage },
      new Map([
        [parent.id, parent],
        [otherParent.id, otherParent],
        [child.id, resolvedChild]
      ]),
      true
    )

    expect(
      rows.filter((row) => row.type === 'item').map((row) => [row.worktree.id, row.depth])
    ).toEqual([
      [parent.id, 0],
      [otherParent.id, 0],
      [child.id, 1]
    ])
  })
})
