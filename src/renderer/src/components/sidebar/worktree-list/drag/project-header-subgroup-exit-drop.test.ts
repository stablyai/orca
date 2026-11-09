import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { computeCombinedProjectHeaderDropTarget } from './project-header-group-drop'
import { getProjectGroupMutationsForDrop } from './project-group-header-drag-commit'
import {
  computeCombinedProjectGroupHeaderDropTarget,
  getReparentableTargetGroupIdsForGroup
} from './project-group-header-reparent-drop'

function makeGroup(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

describe('subgroup exit and tier-constrained group drops', () => {
  it('allows dragging a project from a subgroup into an expanded parent group with zero direct projects (both above and right below the subgroup)', () => {
    const groupHeaderRects = [
      {
        groupId: 'g-root',
        bucketKey: 'root',
        headerIndex: 0,
        top: 0,
        bottom: 28,
        sectionBottom: 164
      },
      {
        groupId: 'g-sub',
        bucketKey: 'parent:g-root',
        headerIndex: 0,
        top: 34,
        bottom: 62,
        sectionBottom: 164
      }
    ]
    const repoHeaderRects = [
      {
        repoId: 'unity',
        bucketKey: 'group:g-sub',
        headerIndex: 0,
        top: 72,
        bottom: 100,
        sectionBottom: 164
      }
    ]
    const buckets = new Map<string, readonly string[]>([['group:g-sub', ['unity']]])

    // 1. Gap between parent header (0..28) and subgroup header (34..62)
    const aboveSubgroup = computeCombinedProjectHeaderDropTarget({
      pointerY: 31,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g-sub',
      currentParentGroupId: 'g-root',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-root', 'g-sub']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: buckets,
      contentBottom: 164
    })
    expect(aboveSubgroup).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g-root',
      dropIndex: 0,
      dropIndicatorY: 32
    })

    // 2. Subgroup exit band right below the subgroup (y = 172, within 20px of 164) -> parent group!
    const belowSubgroupExitBand = computeCombinedProjectHeaderDropTarget({
      pointerY: 172,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g-sub',
      currentParentGroupId: 'g-root',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-root', 'g-sub']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: buckets,
      contentBottom: 164
    })
    expect(belowSubgroupExitBand).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g-root',
      dropIndex: 0,
      dropIndicatorY: 166
    })

    // 3. Dragging further down past the parent exit band (y = 192) -> ungrouped root!
    const furtherDownRoot = computeCombinedProjectHeaderDropTarget({
      pointerY: 192,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g-sub',
      currentParentGroupId: 'g-root',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-root', 'g-sub']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: buckets,
      contentBottom: 164
    })
    expect(furtherDownRoot).toEqual({
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 0,
      dropIndicatorY: 168
    })

    // 4. In recent order (allowSlotReorder: false), membership exits to parent and ungrouped stay active, while same-bucket stays inert
    expect(
      computeCombinedProjectHeaderDropTarget({
        pointerY: 172,
        containerTop: 0,
        scrollTop: 0,
        currentGroupId: 'g-sub',
        currentParentGroupId: 'g-root',
        allowSlotReorder: false,
        joinableGroupIds: new Set(['g-root', 'g-sub']),
        groupHeaderRects,
        repoHeaderRects,
        sidebarRepoHeaderIdsByBucket: buckets,
        contentBottom: 164
      })
    ).toEqual({
      kind: 'slot',
      targetBucketKey: 'group:g-root',
      dropIndex: 0,
      dropIndicatorY: 166
    })
    expect(
      computeCombinedProjectHeaderDropTarget({
        pointerY: 192,
        containerTop: 0,
        scrollTop: 0,
        currentGroupId: 'g-sub',
        currentParentGroupId: 'g-root',
        allowSlotReorder: false,
        joinableGroupIds: new Set(['g-root', 'g-sub']),
        groupHeaderRects,
        repoHeaderRects,
        sidebarRepoHeaderIdsByBucket: buckets,
        contentBottom: 164
      })
    ).toEqual({
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 0,
      dropIndicatorY: 168
    })
    expect(
      computeCombinedProjectHeaderDropTarget({
        pointerY: 85,
        containerTop: 0,
        scrollTop: 0,
        currentGroupId: 'g-sub',
        currentParentGroupId: 'g-root',
        allowSlotReorder: false,
        joinableGroupIds: new Set(['g-root', 'g-sub']),
        groupHeaderRects,
        repoHeaderRects,
        sidebarRepoHeaderIdsByBucket: buckets,
        contentBottom: 164
      })
    ).toBeNull()
  })

  it('targets the destination parent unpinned tier on cross-parent group drops, including pinned-only destinations', () => {
    const p1 = makeGroup('p1', { tabOrder: 0, isPinned: true })
    const subPinned = makeGroup('sub-pinned', {
      parentGroupId: 'p1',
      tabOrder: 0,
      isPinned: true
    })
    const u1 = makeGroup('u1', { tabOrder: 1, isPinned: false })
    const groups = [p1, subPinned, u1]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))
    const rects = [
      { groupId: 'p1', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28, sectionBottom: 100 },
      {
        groupId: 'sub-pinned',
        bucketKey: 'parent:p1',
        headerIndex: 0,
        top: 60,
        bottom: 88,
        sectionBottom: 100
      },
      {
        groupId: 'u1',
        bucketKey: 'root',
        headerIndex: 1,
        top: 108,
        bottom: 136,
        sectionBottom: 136
      }
    ]
    const buckets = new Map<string, readonly string[]>([
      ['root', ['p1', 'u1']],
      ['parent:p1', ['sub-pinned']]
    ])

    const promoteTarget = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 104,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: subPinned,
      projectGroupById: byId,
      reparentableGroupIds: getReparentableTargetGroupIdsForGroup(subPinned, groups),
      groupHeaderRects: rects,
      sidebarProjectGroupHeaderIdsByBucket: buckets,
      contentBottom: 136
    })
    expect(promoteTarget).toEqual({
      kind: 'slot',
      targetBucketKey: 'root',
      dropIndex: 0,
      dropIndicatorY: 104
    })
    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: subPinned,
        sourceBucketKey: 'parent:p1',
        dropTarget: promoteTarget!,
        projectGroupById: byId,
        sidebarProjectGroupHeaderIdsByBucket: buckets
      })
    ).toEqual([
      { groupId: 'sub-pinned', updates: { parentGroupId: null, tabOrder: 1 } },
      { groupId: 'u1', updates: { tabOrder: 2 } }
    ])

    const intoPinnedOnlyParent = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 42,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: u1,
      projectGroupById: byId,
      reparentableGroupIds: getReparentableTargetGroupIdsForGroup(u1, groups),
      groupHeaderRects: rects,
      sidebarProjectGroupHeaderIdsByBucket: buckets,
      contentBottom: 136
    })
    expect(intoPinnedOnlyParent).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:p1',
      dropIndex: 0,
      dropIndicatorY: 104
    })
    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: u1,
        sourceBucketKey: 'root',
        dropTarget: intoPinnedOnlyParent!,
        projectGroupById: byId,
        sidebarProjectGroupHeaderIdsByBucket: buckets
      })
    ).toEqual([{ groupId: 'u1', updates: { parentGroupId: 'p1', tabOrder: 1 } }])

    const p2 = makeGroup('p2', { tabOrder: 1, isPinned: true })
    const uRoot = makeGroup('u-root', { tabOrder: 2, isPinned: false })
    const tallGroups = [p1, p2, subPinned, uRoot]
    const tallById = new Map(tallGroups.map((entry) => [entry.id, entry]))
    const overTallPinnedRootPrefix = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 210,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: subPinned,
      projectGroupById: tallById,
      reparentableGroupIds: getReparentableTargetGroupIdsForGroup(subPinned, tallGroups),
      groupHeaderRects: [
        {
          groupId: 'p1',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 100
        },
        {
          groupId: 'sub-pinned',
          bucketKey: 'parent:p1',
          headerIndex: 0,
          top: 60,
          bottom: 88,
          sectionBottom: 100
        },
        {
          groupId: 'p2',
          bucketKey: 'root',
          headerIndex: 1,
          top: 220,
          bottom: 248,
          sectionBottom: 300
        },
        {
          groupId: 'u-root',
          bucketKey: 'root',
          headerIndex: 2,
          top: 340,
          bottom: 368,
          sectionBottom: 368
        }
      ],
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['p1', 'p2', 'u-root']],
        ['parent:p1', ['sub-pinned']]
      ]),
      contentBottom: 380
    })
    expect(overTallPinnedRootPrefix).toEqual({
      kind: 'slot',
      targetBucketKey: 'root',
      dropIndex: 0,
      dropIndicatorY: 336
    })
  })
})
