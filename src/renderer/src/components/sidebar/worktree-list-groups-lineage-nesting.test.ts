import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import { getLineageGroupKey, getWorktreeLineageGroupKey } from './worktree-list/grouping/group-keys'
import { getLineageRenderInfo, getWorktreeLineageAncestors } from './worktree-lineage-projection'
import { worktree, repoMap } from './worktree-list-groups-test-fixtures'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'

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
  const grandchild: Worktree = {
    ...worktree,
    id: 'wt-grandchild',
    instanceId: 'grandchild-instance',
    displayName: 'nested-worker'
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
  const grandchildLineage: WorktreeLineage = {
    worktreeId: grandchild.id,
    worktreeInstanceId: 'grandchild-instance',
    parentWorktreeId: child.id,
    parentWorktreeInstanceId: 'child-instance',
    origin: 'cli',
    capture: { source: 'terminal-context', confidence: 'inferred' },
    createdAt: 1
  }

  it('keeps lineage flat when nesting is off', () => {
    const rows = buildRows(
      'none',
      [child, parent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: lineage },
      new Map([
        [parent.id, parent],
        [child.id, child]
      ])
    )

    const items = rows.filter((row) => row.type === 'item')
    expect(items[0]).toMatchObject({ type: 'item', worktree: { id: child.id } })
    expect(items[0]).not.toHaveProperty('parentLabel')
    expect(items[1]).toMatchObject({
      type: 'item',
      worktree: { id: parent.id }
    })
  })

  it('places children directly under their parent when nesting is on', () => {
    const rows = buildRows(
      'none',
      [child, parent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: lineage },
      new Map([
        [parent.id, parent],
        [child.id, child]
      ]),
      true
    )

    const items = rows.filter((row) => row.type === 'item')
    expect(items[0]).toMatchObject({ type: 'item', worktree: { id: parent.id } })
    expect(items[1]).toMatchObject({
      type: 'item',
      worktree: { id: child.id },
      depth: 1
    })
  })

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

  it('nests stable-update resolved legacy lineage when generalized lineage is absent', () => {
    const parentId =
      '32a0226d-9f33-42e8-8b7b-24867dea06d4::/Users/jinwoo/orca/workspaces/orca/assigned-issues'
    const childId =
      '32a0226d-9f33-42e8-8b7b-24867dea06d4::/Users/jinwoo/orca/workspaces/orca/issue-9276-nested-ssh-runtime-routing'
    const secondChildId =
      '32a0226d-9f33-42e8-8b7b-24867dea06d4::/Users/jinwoo/orca/workspaces/orca/issue-9744-terminal-close-lifecycle'
    const resolvedParent: ResolvedLineageWorktree = {
      ...parent,
      id: parentId,
      instanceId: 'b0ffd635-91cd-424f-b804-80d4bb277a4c',
      lineage: null,
      workspaceLineage: null
    }
    const resolvedLineage: WorktreeLineage = {
      ...lineage,
      worktreeId: childId,
      worktreeInstanceId: '1ceb9823-aa98-4f79-8eaa-af0b3a3d551b',
      parentWorktreeId: parentId,
      parentWorktreeInstanceId: 'b0ffd635-91cd-424f-b804-80d4bb277a4c',
      capture: { source: 'explicit-cli-flag', confidence: 'explicit' }
    }
    const resolvedChild: ResolvedLineageWorktree = {
      ...child,
      id: childId,
      instanceId: '1ceb9823-aa98-4f79-8eaa-af0b3a3d551b',
      lineage: resolvedLineage,
      workspaceLineage: null
    }
    const secondResolvedLineage: WorktreeLineage = {
      ...resolvedLineage,
      worktreeId: secondChildId,
      worktreeInstanceId: '87e2ef9a-99d3-48e3-9a53-3d1a979b5417'
    }
    const secondResolvedChild: ResolvedLineageWorktree = {
      ...child,
      id: secondChildId,
      instanceId: '87e2ef9a-99d3-48e3-9a53-3d1a979b5417',
      lineage: secondResolvedLineage,
      workspaceLineage: null
    }

    const rows = buildRows(
      'none',
      [secondResolvedChild, resolvedChild, resolvedParent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [resolvedParent.id, resolvedParent],
        [resolvedChild.id, resolvedChild],
        [secondResolvedChild.id, secondResolvedChild]
      ]),
      true
    )

    const items = rows.filter((row) => row.type === 'item')
    expect(items.map((row) => [row.worktree.id, row.depth])).toEqual([
      [parentId, 0],
      [secondChildId, 1],
      [childId, 1]
    ])
    expect(items[0]).toMatchObject({ lineageChildCount: 2, lineageCollapsed: false })
  })

  it('rejects stale resolved lineage after a parent instance is replaced', () => {
    const resolvedChild: ResolvedLineageWorktree = {
      ...child,
      lineage: { ...lineage, parentWorktreeInstanceId: 'replaced-parent-instance' }
    }
    const rows = buildRows(
      'none',
      [resolvedChild, parent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [parent.id, parent],
        [resolvedChild.id, resolvedChild]
      ]),
      true
    )

    expect(rows.filter((row) => row.type === 'item').map((row) => row.depth)).toEqual([0, 0])
  })

  it('keeps mixed cyclic lineage participants visible as roots', () => {
    const parentLineage: WorktreeLineage = {
      ...lineage,
      worktreeId: parent.id,
      worktreeInstanceId: parent.instanceId!,
      parentWorktreeId: child.id,
      parentWorktreeInstanceId: child.instanceId!
    }
    const rows = buildRows(
      'none',
      [grandchild, child, parent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: lineage, [parent.id]: parentLineage },
      new Map([
        [parent.id, parent],
        [child.id, child],
        [grandchild.id, grandchild]
      ]),
      true
    )

    expect(
      rows.filter((row) => row.type === 'item').map((row) => [row.worktree.id, row.depth])
    ).toEqual([
      [grandchild.id, 0],
      [child.id, 0],
      [parent.id, 0]
    ])
  })

  it('resolves inline-only ancestor chains for reveal and temporary picker expansion', () => {
    const resolvedChild: ResolvedLineageWorktree = { ...child, lineage }
    const resolvedGrandchild: ResolvedLineageWorktree = {
      ...grandchild,
      lineage: grandchildLineage
    }
    const worktreeMap = new Map<string, Worktree>([
      [parent.id, parent],
      [resolvedChild.id, resolvedChild],
      [resolvedGrandchild.id, resolvedGrandchild]
    ])

    expect(
      getWorktreeLineageAncestors(resolvedGrandchild, {}, worktreeMap).map(
        (worktree) => worktree.id
      )
    ).toEqual([child.id, parent.id])
  })

  it('keeps a resolved child at the root when its parent is missing', () => {
    const resolvedChild: ResolvedLineageWorktree = { ...child, lineage }
    const rows = buildRows(
      'none',
      [resolvedChild],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[child.id, resolvedChild]]),
      true
    )

    expect(rows.find((row) => row.type === 'item')).toMatchObject({ depth: 0 })
  })

  it.each([
    ['repo', { repoId: 'other-repo' }],
    ['host', { hostId: 'ssh:other-host' as const }],
    ['project', { projectId: 'github:other/project' }]
  ])('does not nest resolved lineage across a known %s boundary', (_label, boundary) => {
    const boundedParent = {
      ...parent,
      repoId: 'repo-1',
      hostId: 'local' as const,
      projectId: 'github:stablyai/orca',
      ...boundary
    }
    const boundedChild: ResolvedLineageWorktree = {
      ...child,
      repoId: 'repo-1',
      hostId: 'local' as const,
      projectId: 'github:stablyai/orca',
      lineage
    }
    const rows = buildRows(
      'none',
      [boundedChild, boundedParent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map<string, Worktree>([
        [boundedParent.id, boundedParent],
        [boundedChild.id, boundedChild]
      ]),
      true
    )

    expect(rows.filter((row) => row.type === 'item').map((row) => row.depth)).toEqual([0, 0])
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

  it('supports nested lineage chains beyond one level', () => {
    const rows = buildRows(
      'none',
      [grandchild, child, parent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: lineage, [grandchild.id]: grandchildLineage },
      new Map([
        [parent.id, parent],
        [child.id, child],
        [grandchild.id, grandchild]
      ]),
      true
    )

    const items = rows.filter((row) => row.type === 'item')
    expect(items.map((row) => row.worktree.id)).toEqual([parent.id, child.id, grandchild.id])
    expect(items[0]).toMatchObject({
      type: 'item',
      depth: 0,
      lineageChildCount: 1,
      lineageCollapsed: false
    })
    expect(items[1]).toMatchObject({
      type: 'item',
      worktree: { id: child.id },
      depth: 1,
      lineageChildCount: 1
    })
    expect(items[2]).toMatchObject({
      type: 'item',
      worktree: { id: grandchild.id },
      depth: 2,
      lineageChildCount: 0
    })
  })

  it('collapses descendants under lineage parents', () => {
    const rows = buildRows(
      'none',
      [grandchild, child, parent],
      repoMap,
      null,
      new Set([getLineageGroupKey(parent.id)]),
      undefined,
      undefined,
      undefined,
      { [child.id]: lineage, [grandchild.id]: grandchildLineage },
      new Map([
        [parent.id, parent],
        [child.id, child],
        [grandchild.id, grandchild]
      ]),
      true
    )

    const items = rows.filter((row) => row.type === 'item')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: 'item',
      worktree: { id: parent.id },
      lineageChildCount: 1,
      lineageCollapsed: true
    })
  })

  it('does not create a parent group for stale instance links', () => {
    const staleLineage = { ...lineage, parentWorktreeInstanceId: 'old-parent-instance' }
    const rows = buildRows(
      'none',
      [child],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: staleLineage },
      new Map([
        [parent.id, parent],
        [child.id, child]
      ]),
      true
    )

    const item = rows.find((row) => row.type === 'item')
    expect(item).toMatchObject({
      type: 'item',
      worktree: { id: child.id },
      depth: 0
    })
  })

  it('marks stale instance links as missing for shared context-menu validation', () => {
    const staleLineage = { ...lineage, parentWorktreeInstanceId: 'old-parent-instance' }
    const info = getLineageRenderInfo(
      child,
      { [child.id]: staleLineage },
      new Map([
        [parent.id, parent],
        [child.id, child]
      ]),
      new Set()
    )

    expect(info).toMatchObject({ state: 'missing' })
  })

  it('nests unpinned children under a pinned parent in Pinned', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const rows = buildRows(
      'none',
      [child, pinnedParent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: lineage },
      new Map([
        [pinnedParent.id, pinnedParent],
        [child.id, child]
      ]),
      true
    )

    const items = rows.filter((row) => row.type === 'item')
    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned', count: 2 })
    expect(items.map((row) => [row.worktree.id, row.depth, row.sectionKey])).toEqual([
      [pinnedParent.id, 0, 'pinned'],
      [child.id, 1, 'pinned']
    ])
    expect(rows.some((row) => row.type === 'header' && row.key === 'all')).toBe(false)
  })

  it('nests grandchildren under a pinned ancestor in Pinned', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const rows = buildRows(
      'none',
      [grandchild, child, pinnedParent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: lineage, [grandchild.id]: grandchildLineage },
      new Map([
        [pinnedParent.id, pinnedParent],
        [child.id, child],
        [grandchild.id, grandchild]
      ]),
      true
    )

    expect(
      rows.filter((row) => row.type === 'item').map((row) => [row.worktree.id, row.depth])
    ).toEqual([
      [pinnedParent.id, 0],
      [child.id, 1],
      [grandchild.id, 2]
    ])
  })

  it('duplicates a pinned parent tree into All when the policy allows it', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const rows = buildRows(
      'none',
      [child, pinnedParent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: lineage },
      new Map([
        [pinnedParent.id, pinnedParent],
        [child.id, child]
      ]),
      true,
      { showPinnedWorktreesInGroups: true } as never
    )

    expect(
      rows
        .filter((row) => row.type === 'item')
        .map((row) => [row.sectionKey, row.worktree.id, row.depth])
    ).toEqual([
      ['pinned', pinnedParent.id, 0],
      ['pinned', child.id, 1],
      ['all', pinnedParent.id, 0],
      ['all', child.id, 1]
    ])
  })

  it('nests a pinned child under its pinned parent in Pinned', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const pinnedChild = { ...child, isPinned: true }
    const rows = buildRows(
      'none',
      [pinnedChild, pinnedParent],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: lineage },
      new Map([
        [pinnedParent.id, pinnedParent],
        [pinnedChild.id, pinnedChild]
      ]),
      true
    )

    expect(
      rows.filter((row) => row.type === 'item').map((row) => [row.worktree.id, row.depth])
    ).toEqual([
      [pinnedParent.id, 0],
      [pinnedChild.id, 1]
    ])
  })

  it('keeps pinned children in Pinned without a parent badge', () => {
    const pinnedChild = { ...child, isPinned: true }
    const rows = buildRows(
      'none',
      [parent, pinnedChild],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      { [child.id]: lineage },
      new Map([
        [parent.id, parent],
        [child.id, pinnedChild]
      ]),
      true
    )

    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned' })
    expect(rows[1]).toMatchObject({
      type: 'item',
      worktree: { id: child.id }
    })
    expect(rows[1]).not.toHaveProperty('parentLabel')
  })
})
