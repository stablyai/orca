import { describe, expect, it } from 'vitest'
import { resolveHeaderDragBlockUnits } from './header-drag-block-units'
import type { RenderRow } from './worktree-list-virtual-rows'

/** Mirrors the real getRenderRowKey exactly (same branch order and default
 *  `wt:` fall-through). Injected so the tests don't import WorktreeList. */
function getRowKey(row: RenderRow): string {
  if (row.type === 'host-header') {
    return `host:${row.hostId}`
  }
  if (row.type === 'header') {
    return `hdr:${row.key}`
  }
  if (row.type === 'lineage-group') {
    return `lineage-group:${row.key}`
  }
  if (row.type === 'imported-worktrees-card') {
    return `imported:${row.key}`
  }
  if (row.type === 'new-external-worktrees-inbox') {
    return `inbox:${row.key}`
  }
  if (row.type === 'pending-creation') {
    return `pending:${row.creationId}`
  }
  if (row.type === 'folder-workspace') {
    return `folder-workspace:${row.folderWorkspace.id}`
  }
  return `wt:${row.rowKey}`
}

// Helpers to build minimal RenderRow fixtures. The types are complex domain
// objects; `as never` satisfies deep required fields we don't need for these
// pure-segmentation tests (matching convention in worktree-list-groups.test.ts).

function headerRow(opts: {
  key: string
  repoId?: string
  groupId?: string
  projectGroupDepth?: number
}): RenderRow {
  return {
    type: 'header',
    key: opts.key,
    label: opts.key,
    count: 0,
    tone: '',
    repo: opts.repoId ? ({ id: opts.repoId } as never) : undefined,
    projectGroup: opts.groupId ? ({ id: opts.groupId } as never) : undefined,
    projectGroupDepth: opts.projectGroupDepth
  } as never
}

function worktreeRow(rowKey: string): RenderRow {
  return { type: 'item', rowKey, sectionKey: '', worktree: { id: rowKey } as never } as never
}

/** Build virtualItems from a flat list of sizes, one per renderRow index. */
function makeVirtualItems(sizes: number[]): { index: number; start: number; size: number }[] {
  const items: { index: number; start: number; size: number }[] = []
  let pos = 0
  for (let i = 0; i < sizes.length; i++) {
    items.push({ index: i, start: pos, size: sizes[i]! })
    pos += sizes[i]!
  }
  return items
}

describe('resolveHeaderDragBlockUnits — no drag active', () => {
  it('returns null when both draggingRepoId and draggingGroupId are null', () => {
    const rows: RenderRow[] = [headerRow({ key: 'repo:r1', repoId: 'r1' }), worktreeRow('wt-a')]
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: makeVirtualItems([28, 116]),
      draggingRepoId: null,
      draggingGroupId: null,
      getRowKey
    })
    expect(result).toBeNull()
  })

  it('returns null when the dragged header is not present in renderRows', () => {
    const rows: RenderRow[] = [headerRow({ key: 'repo:r1', repoId: 'r1' }), worktreeRow('wt-a')]
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: makeVirtualItems([28, 116]),
      draggingRepoId: 'repo-missing',
      draggingGroupId: null,
      getRowKey
    })
    expect(result).toBeNull()
  })

  it('returns null when the dragged header is off-screen (no virtualItem for its index)', () => {
    const rows: RenderRow[] = [headerRow({ key: 'repo:r1', repoId: 'r1' }), worktreeRow('wt-a')]
    // Only the worktree row is virtualised, not index 0 (the header)
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: [{ index: 1, start: 28, size: 116 }],
      draggingRepoId: 'r1',
      draggingGroupId: null,
      getRowKey
    })
    expect(result).toBeNull()
  })
})

describe('resolveHeaderDragBlockUnits — project drag', () => {
  // Layout:
  //   idx 0: group header (group-a, depth 0)
  //   idx 1: project header (repo-1, depth 1)  ← dragged
  //   idx 2: worktree wt-1
  //   idx 3: project header (repo-2, depth 1)
  //   idx 4: worktree wt-2
  //   idx 5: project header (repo-3, depth 1)
  //   idx 6: worktree wt-3
  const rows: RenderRow[] = [
    headerRow({ key: 'project-group:g1', groupId: 'group-a', projectGroupDepth: 0 }),
    headerRow({ key: 'repo:r1', repoId: 'repo-1', projectGroupDepth: 1 }),
    worktreeRow('wt-1'),
    headerRow({ key: 'repo:r2', repoId: 'repo-2', projectGroupDepth: 1 }),
    worktreeRow('wt-2'),
    headerRow({ key: 'repo:r3', repoId: 'repo-3', projectGroupDepth: 1 }),
    worktreeRow('wt-3')
  ]
  const sizes = [28, 28, 116, 28, 116, 28, 116]
  const vItems = makeVirtualItems(sizes)

  it('blockKeys contains exactly the dragged project header + its worktree', () => {
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: vItems,
      draggingRepoId: 'repo-1',
      draggingGroupId: null,
      getRowKey
    })
    expect(result).not.toBeNull()
    expect(result!.blockKeys).toEqual(new Set(['hdr:repo:r1', 'wt:wt-1']))
  })

  it('blockTop and blockBottom span the dragged project block', () => {
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: vItems,
      draggingRepoId: 'repo-1',
      draggingGroupId: null,
      getRowKey
    })
    // idx 1 starts at 28, idx 3 (next header) starts at 172 → blockBottom = 172
    expect(result!.blockTop).toBe(28)
    expect(result!.blockBottom).toBe(172)
  })

  it('each project header + its worktrees forms its own unit', () => {
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: vItems,
      draggingRepoId: 'repo-1',
      draggingGroupId: null,
      getRowKey
    })
    // All headers (including the group header at depth 0 and the project
    // headers at depth 1) are independent units during project drag.
    expect(result!.units).toHaveLength(4)
    // First unit: the group header at idx 0
    expect(result!.units[0]).toMatchObject({ headerTop: 0, rowKeys: ['hdr:project-group:g1'] })
    // Second unit: dragged project header + its worktree
    expect(result!.units[1]).toMatchObject({ headerTop: 28, rowKeys: ['hdr:repo:r1', 'wt:wt-1'] })
    // Third unit: next project header + its worktree
    expect(result!.units[2]).toMatchObject({ headerTop: 172, rowKeys: ['hdr:repo:r2', 'wt:wt-2'] })
    // Fourth unit: last project header + its worktree
    expect(result!.units[3]).toMatchObject({ headerTop: 316, rowKeys: ['hdr:repo:r3', 'wt:wt-3'] })
  })

  it('blockBottom is computed from sizes when the end row is off-screen', () => {
    // Only virtualise rows 0–2 (group header + first project + its worktree).
    // The end boundary (index 3) is not in virtualItems, so blockBottom must
    // be calculated by summing sizes of rows 1 and 2.
    const partialVItems = vItems.slice(0, 3) // indices 0,1,2
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: partialVItems,
      draggingRepoId: 'repo-1',
      draggingGroupId: null,
      getRowKey
    })
    // blockTop = 28; sizes[1] + sizes[2] = 28 + 116 = 144; blockBottom = 28 + 144 = 172
    expect(result!.blockTop).toBe(28)
    expect(result!.blockBottom).toBe(172)
  })
})

describe('resolveHeaderDragBlockUnits — group drag', () => {
  // Layout:
  //   idx 0: group header group-A (depth 0)     ← dragged
  //   idx 1:   project header repo-1 (depth 1)
  //   idx 2:     worktree wt-1
  //   idx 3:   group header group-B (depth 1)   ← nested inside group-A
  //   idx 4:     project header repo-2 (depth 2)
  //   idx 5:       worktree wt-2
  //   idx 6: group header group-C (depth 0)     ← sibling, ends the block
  //   idx 7:   project header repo-3 (depth 1)
  //   idx 8:     worktree wt-3
  const rows: RenderRow[] = [
    headerRow({ key: 'project-group:gA', groupId: 'group-A', projectGroupDepth: 0 }),
    headerRow({ key: 'repo:r1', repoId: 'repo-1', projectGroupDepth: 1 }),
    worktreeRow('wt-1'),
    headerRow({ key: 'project-group:gB', groupId: 'group-B', projectGroupDepth: 1 }),
    headerRow({ key: 'repo:r2', repoId: 'repo-2', projectGroupDepth: 2 }),
    worktreeRow('wt-2'),
    headerRow({ key: 'project-group:gC', groupId: 'group-C', projectGroupDepth: 0 }),
    headerRow({ key: 'repo:r3', repoId: 'repo-3', projectGroupDepth: 1 }),
    worktreeRow('wt-3')
  ]
  const sizes = [28, 28, 116, 28, 28, 116, 28, 28, 116]
  const vItems = makeVirtualItems(sizes)

  it('blockKeys spans the entire group-A subtree (indices 0–5)', () => {
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: vItems,
      draggingRepoId: null,
      draggingGroupId: 'group-A',
      getRowKey
    })
    expect(result).not.toBeNull()
    expect(result!.blockKeys).toEqual(
      new Set([
        'hdr:project-group:gA',
        'hdr:repo:r1',
        'wt:wt-1',
        'hdr:project-group:gB',
        'hdr:repo:r2',
        'wt:wt-2'
      ])
    )
  })

  it('blockTop and blockBottom span indices 0 through 5', () => {
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: vItems,
      draggingRepoId: null,
      draggingGroupId: 'group-A',
      getRowKey
    })
    // blockTop = start[0] = 0; blockBottom = start[6] = 344
    expect(result!.blockTop).toBe(0)
    expect(result!.blockBottom).toBe(344)
  })

  it('sibling group-C is its own unit containing its subtree', () => {
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: vItems,
      draggingRepoId: null,
      draggingGroupId: 'group-A',
      getRowKey
    })
    // During group drag, only depth-0 group headers start units. The dragged
    // group-A (idx 0) is one unit; sibling group-C (idx 6) is a second unit
    // whose subtree (repo-3 + wt-3) continues with it.
    expect(result!.units).toHaveLength(2)
    expect(result!.units[0]).toMatchObject({
      headerTop: 0,
      rowKeys: [
        'hdr:project-group:gA',
        'hdr:repo:r1',
        'wt:wt-1',
        'hdr:project-group:gB',
        'hdr:repo:r2',
        'wt:wt-2'
      ]
    })
    expect(result!.units[1]).toMatchObject({
      headerTop: 344,
      rowKeys: ['hdr:project-group:gC', 'hdr:repo:r3', 'wt:wt-3']
    })
  })

  it('dragging a nested group only takes its own subtree as the block', () => {
    // Dragging group-B (depth 1) — its block ends at group-C (depth 0) which
    // is shallower than depth 1. The block is indices 3–5.
    const result = resolveHeaderDragBlockUnits({
      renderRows: rows,
      virtualItems: vItems,
      draggingRepoId: null,
      draggingGroupId: 'group-B',
      getRowKey
    })
    expect(result!.blockKeys).toEqual(new Set(['hdr:project-group:gB', 'hdr:repo:r2', 'wt:wt-2']))
    // blockTop = start[3] = 172; blockBottom = start[6] = 344
    expect(result!.blockTop).toBe(172)
    expect(result!.blockBottom).toBe(344)
  })
})
