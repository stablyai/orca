import { describe, expect, it } from 'vitest'

import {
  computeProjectGroupHeaderDropTarget,
  type ComputeProjectGroupHeaderDropTargetArgs
} from './project-group-header-drop-target'
import type { ProjectGroupHeaderDragRect } from './project-group-header-drop'
import { createProjectGroupReparentValidator } from '../../../../shared/project-group-reparent'

type GroupNode = { id: string; parentGroupId: string | null }

function rect(
  groupId: string,
  bucketKey: string,
  headerIndex: number,
  top: number
): ProjectGroupHeaderDragRect {
  return { groupId, bucketKey, headerIndex, top, bottom: top + 28 }
}

// Sidebar layout: alpha (root) > gamma (nested in alpha), then beta (root).
const GROUPS: GroupNode[] = [
  { id: 'alpha', parentGroupId: null },
  { id: 'gamma', parentGroupId: 'alpha' },
  { id: 'beta', parentGroupId: null }
]

const RECTS = [
  rect('alpha', 'root', 0, 0),
  rect('gamma', 'parent:alpha', 0, 28),
  rect('beta', 'root', 1, 56)
]

const IDS_BY_BUCKET = new Map<string, readonly string[]>([
  ['root', ['alpha', 'beta']],
  ['parent:alpha', ['gamma']]
])

function makeArgs(
  overrides: Partial<ComputeProjectGroupHeaderDropTargetArgs> & { groups?: GroupNode[] }
): ComputeProjectGroupHeaderDropTargetArgs {
  const { groups = GROUPS, ...rest } = overrides
  const merged = {
    pointerY: 0,
    containerTop: 0,
    scrollTop: 0,
    rects: RECTS,
    draggedGroupId: 'gamma',
    sourceBucketKey: 'parent:alpha',
    sourceParentGroupId: 'alpha',
    draggedSubtreeGroupIds: new Set(['gamma']),
    sidebarProjectGroupHeaderIdsByBucket: IDS_BY_BUCKET,
    ...rest
  }
  return {
    ...merged,
    validateReparent:
      merged.validateReparent ?? createProjectGroupReparentValidator(groups, merged.draggedGroupId)
  }
}

describe('computeProjectGroupHeaderDropTarget', () => {
  it('nests into a hovered header center', () => {
    expect(computeProjectGroupHeaderDropTarget(makeArgs({ pointerY: 70 }))).toEqual({
      kind: 'nest',
      targetGroupId: 'beta'
    })
  })

  it('reorders into the hovered bucket from a header edge', () => {
    // Top quarter of beta's header: sibling reorder in root, which un-nests
    // the dragged nested group.
    const target = computeProjectGroupHeaderDropTarget(makeArgs({ pointerY: 58 }))
    expect(target).toMatchObject({ kind: 'reorder', bucketKey: 'root', dropIndex: 1 })
  })

  it('falls back to reorder when hovering the center of the current parent', () => {
    const target = computeProjectGroupHeaderDropTarget(makeArgs({ pointerY: 10 }))
    expect(target).toMatchObject({ kind: 'reorder', bucketKey: 'root', dropIndex: 0 })
  })

  it('keeps same-bucket reorder alive over the dragged header itself', () => {
    const target = computeProjectGroupHeaderDropTarget(makeArgs({ pointerY: 40 }))
    expect(target).toMatchObject({ kind: 'reorder', bucketKey: 'parent:alpha' })
  })

  it('returns null over a descendant of the dragged group', () => {
    expect(
      computeProjectGroupHeaderDropTarget(
        makeArgs({
          pointerY: 40,
          draggedGroupId: 'alpha',
          sourceBucketKey: 'root',
          sourceParentGroupId: null,
          draggedSubtreeGroupIds: new Set(['alpha', 'gamma'])
        })
      )
    ).toBeNull()
  })

  it('rejects a nest that would exceed the manual depth cap', () => {
    const groups: GroupNode[] = [
      { id: 'l1', parentGroupId: null },
      { id: 'l2', parentGroupId: 'l1' },
      { id: 'l3', parentGroupId: 'l2' },
      { id: 'solo', parentGroupId: null }
    ]
    const rects = [
      rect('l1', 'root', 0, 0),
      rect('l2', 'parent:l1', 0, 28),
      rect('l3', 'parent:l2', 0, 56),
      rect('solo', 'root', 1, 84)
    ]
    const idsByBucket = new Map<string, readonly string[]>([
      ['root', ['l1', 'solo']],
      ['parent:l1', ['l2']],
      ['parent:l2', ['l3']]
    ])
    // Center of l3 (depth 3): nesting under it would land at depth 4, so the
    // drop resolves to a sibling reorder beside l3 instead.
    const target = computeProjectGroupHeaderDropTarget(
      makeArgs({
        pointerY: 70,
        rects,
        draggedGroupId: 'solo',
        sourceBucketKey: 'root',
        sourceParentGroupId: null,
        draggedSubtreeGroupIds: new Set(['solo']),
        sidebarProjectGroupHeaderIdsByBucket: idsByBucket,
        groups
      })
    )
    expect(target).toMatchObject({ kind: 'reorder', bucketKey: 'parent:l2' })
  })

  it('rejects a cross-bucket edge drop whose bucket parent would create a cycle', () => {
    // Dragging alpha over the edge zone of its own child's bucket must not
    // reparent alpha under itself.
    const target = computeProjectGroupHeaderDropTarget(
      makeArgs({
        pointerY: 30,
        draggedGroupId: 'alpha',
        sourceBucketKey: 'root',
        sourceParentGroupId: null,
        draggedSubtreeGroupIds: new Set(['alpha', 'gamma'])
      })
    )
    expect(target).toBeNull()
  })

  it('un-nests via the root bucket when dragging past the bottom of the list', () => {
    const target = computeProjectGroupHeaderDropTarget(makeArgs({ pointerY: 120 }))
    expect(target).toMatchObject({ kind: 'reorder', bucketKey: 'root', dropIndex: 2 })
  })
})
