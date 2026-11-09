// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import {
  canProjectGroupStartHeaderDrag,
  computeCombinedProjectGroupHeaderDropTarget,
  getReparentableTargetGroupIdsForGroup
} from './project-group-header-reparent-drop'
import {
  commitProjectGroupHeaderDragDrop,
  getProjectGroupMutationsForDrop
} from './project-group-header-drag-commit'

import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'

function group(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
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
    ...overrides
  }
}

describe('project-group-header-reparent-drop', () => {
  it('excludes self and entire descendant subtree from reparentable target groups', () => {
    const rootA = group('root-a')
    const child = group('child', { parentGroupId: 'root-a' })
    const grandchild = group('grandchild', { parentGroupId: 'child' })
    const rootB = group('root-b')
    const otherHost = group('remote-group', { executionHostId: 'runtime:env-1' })
    const groups = [rootA, child, grandchild, rootB, otherHost]

    const targets = getReparentableTargetGroupIdsForGroup(rootA, groups)

    expect([...targets]).toEqual(['root-b'])
  })

  it('allows starting drag on a lone subgroup to move it out, while keeping a sole root group with only its own child inert', () => {
    const rootA = group('root-a')
    const child = group('child', { parentGroupId: 'root-a' })
    const groups = [rootA, child]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))

    expect(
      canProjectGroupStartHeaderDrag({
        group: child,
        projectGroupById: byId,
        sidebarBucketHeaderIds: ['child'],
        reparentableGroupIds: getReparentableTargetGroupIdsForGroup(child, groups)
      })
    ).toBe(true)

    expect(
      canProjectGroupStartHeaderDrag({
        group: rootA,
        projectGroupById: byId,
        sidebarBucketHeaderIds: ['root-a'],
        reparentableGroupIds: getReparentableTargetGroupIdsForGroup(rootA, groups)
      })
    ).toBe(false)
  })

  it('keeps sole root groups inert when another host contributes a root group to the shared root bucket', () => {
    const localRoot = group('local-root')
    const remoteRoot = group('remote-root', { executionHostId: 'runtime:env-1' })
    const groups = [localRoot, remoteRoot]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))

    expect(
      canProjectGroupStartHeaderDrag({
        group: localRoot,
        projectGroupById: byId,
        sidebarBucketHeaderIds: ['local-root', 'remote-root'],
        reparentableGroupIds: getReparentableTargetGroupIdsForGroup(localRoot, groups)
      })
    ).toBe(false)

    const localRoot2 = group('local-root-2')
    const groupsWithLocalSibling = [localRoot, localRoot2, remoteRoot]
    const byIdWithSibling = new Map(groupsWithLocalSibling.map((entry) => [entry.id, entry]))

    expect(
      canProjectGroupStartHeaderDrag({
        group: localRoot,
        projectGroupById: byIdWithSibling,
        sidebarBucketHeaderIds: ['local-root', 'local-root-2', 'remote-root'],
        reparentableGroupIds: new Set()
      })
    ).toBe(true)
  })

  it('targets a compatible group header center band and blocks self, current parent, and descendants', () => {
    const rootA = group('root-a')
    const child = group('child', { parentGroupId: 'root-a' })
    const rootB = group('root-b')
    const groups = [rootA, child, rootB]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))
    const rects = [
      {
        groupId: 'root-a',
        bucketKey: 'root',
        headerIndex: 0,
        top: 0,
        bottom: 28,
        sectionBottom: 60
      },
      {
        groupId: 'child',
        bucketKey: 'parent:root-a',
        headerIndex: 0,
        top: 32,
        bottom: 60,
        sectionBottom: 60
      },
      {
        groupId: 'root-b',
        bucketKey: 'root',
        headerIndex: 1,
        top: 68,
        bottom: 96,
        sectionBottom: 96
      }
    ]
    const buckets = new Map<string, readonly string[]>([
      ['root', ['root-a', 'root-b']],
      ['parent:root-a', ['child']]
    ])

    // Dragging root-a onto its own descendant 'child' must be rejected (cycle guard)
    expect(
      computeCombinedProjectGroupHeaderDropTarget({
        pointerY: 46,
        containerTop: 0,
        scrollTop: 0,
        draggedGroup: rootA,
        projectGroupById: byId,
        reparentableGroupIds: getReparentableTargetGroupIdsForGroup(rootA, groups),
        groupHeaderRects: rects,
        sidebarProjectGroupHeaderIdsByBucket: buckets
      })
    ).toBeNull()

    // Dragging 'child' onto its current parent 'root-a' header is a no-op
    expect(
      computeCombinedProjectGroupHeaderDropTarget({
        pointerY: 14,
        containerTop: 0,
        scrollTop: 0,
        draggedGroup: child,
        projectGroupById: byId,
        reparentableGroupIds: getReparentableTargetGroupIdsForGroup(child, groups),
        groupHeaderRects: rects,
        sidebarProjectGroupHeaderIdsByBucket: buckets
      })
    ).toBeNull()

    // Dragging 'child' onto 'root-b' header center band nests 'child' into 'root-b'
    expect(
      computeCombinedProjectGroupHeaderDropTarget({
        pointerY: 82,
        containerTop: 0,
        scrollTop: 0,
        draggedGroup: child,
        projectGroupById: byId,
        reparentableGroupIds: getReparentableTargetGroupIdsForGroup(child, groups),
        groupHeaderRects: rects,
        sidebarProjectGroupHeaderIdsByBucket: buckets
      })
    ).toEqual({ kind: 'group-header', groupId: 'root-b' })
  })

  it('allows dragging a lone subgroup below the last root group to promote it to top-level even when contentBottom matches the outer section', () => {
    const rootA = group('root-a', { tabOrder: 0 })
    const child = group('child', { parentGroupId: 'root-a', tabOrder: 0 })
    const groups = [rootA, child]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))
    const rects = [
      {
        groupId: 'root-a',
        bucketKey: 'root',
        headerIndex: 0,
        top: 0,
        bottom: 28,
        sectionBottom: 112
      },
      {
        groupId: 'child',
        bucketKey: 'parent:root-a',
        headerIndex: 0,
        top: 32,
        bottom: 60,
        sectionBottom: 112
      }
    ]
    const buckets = new Map<string, readonly string[]>([
      ['root', ['root-a']],
      ['parent:root-a', ['child']]
    ])

    const target = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 124,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: child,
      projectGroupById: byId,
      reparentableGroupIds: getReparentableTargetGroupIdsForGroup(child, groups),
      groupHeaderRects: rects,
      sidebarProjectGroupHeaderIdsByBucket: buckets,
      contentBottom: 112
    })

    expect(target).toEqual({
      kind: 'slot',
      targetBucketKey: 'root',
      dropIndex: 1,
      dropIndicatorY: 115
    })

    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: child,
        sourceBucketKey: 'parent:root-a',
        dropTarget: target!,
        projectGroupById: byId,
        sidebarProjectGroupHeaderIdsByBucket: buckets
      })
    ).toEqual([
      {
        groupId: 'child',
        updates: { parentGroupId: null, tabOrder: 1 }
      }
    ])
  })

  it('allows dropping a group into an enclosing group interior that has direct projects but zero child subgroups', () => {
    const rootA = group('root-a', { tabOrder: 0 })
    const rootB = group('root-b', { tabOrder: 1 })
    const groups = [rootA, rootB]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))
    const rects = [
      {
        groupId: 'root-a',
        bucketKey: 'root',
        headerIndex: 0,
        top: 0,
        bottom: 28,
        sectionBottom: 120
      },
      {
        groupId: 'root-b',
        bucketKey: 'root',
        headerIndex: 1,
        top: 124,
        bottom: 152,
        sectionBottom: 152
      }
    ]
    const buckets = new Map<string, readonly string[]>([['root', ['root-a', 'root-b']]])

    const target = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 80,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: rootB,
      projectGroupById: byId,
      reparentableGroupIds: getReparentableTargetGroupIdsForGroup(rootB, groups),
      groupHeaderRects: rects,
      sidebarProjectGroupHeaderIdsByBucket: buckets,
      contentBottom: 152
    })

    expect(target).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:root-a',
      dropIndex: 0,
      dropIndicatorY: 124
    })
  })

  it('steps a doubly-nested grandchild group out into its grandparent group in the exit band right below its parent subgroup', () => {
    const rootA = group('root-a', { tabOrder: 0 })
    const child = group('child', { parentGroupId: 'root-a', tabOrder: 0 })
    const grandchild = group('grandchild', { parentGroupId: 'child', tabOrder: 0 })
    const groups = [rootA, child, grandchild]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))
    const rects = [
      {
        groupId: 'root-a',
        bucketKey: 'root',
        headerIndex: 0,
        top: 0,
        bottom: 28,
        sectionBottom: 120
      },
      {
        groupId: 'child',
        bucketKey: 'parent:root-a',
        headerIndex: 0,
        top: 32,
        bottom: 60,
        sectionBottom: 120
      },
      {
        groupId: 'grandchild',
        bucketKey: 'parent:child',
        headerIndex: 0,
        top: 64,
        bottom: 92,
        sectionBottom: 120
      }
    ]
    const buckets = new Map<string, readonly string[]>([
      ['root', ['root-a']],
      ['parent:root-a', ['child']],
      ['parent:child', ['grandchild']]
    ])

    const target = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 132,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: grandchild,
      projectGroupById: byId,
      reparentableGroupIds: getReparentableTargetGroupIdsForGroup(grandchild, groups),
      groupHeaderRects: rects,
      sidebarProjectGroupHeaderIdsByBucket: buckets,
      contentBottom: 120
    })

    expect(target).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:root-a',
      dropIndex: 1,
      dropIndicatorY: 124
    })
  })

  it('aborts sibling tabOrder updates when cross-level reparenting is rejected by the target host', async () => {
    const rootA = group('root-a', { tabOrder: 0 })
    const child = group('child', { parentGroupId: 'root-a', tabOrder: 0 })
    const byId = new Map([
      [rootA.id, rootA],
      [child.id, child]
    ])
    const buckets = new Map<string, readonly string[]>([
      ['root', ['root-a']],
      ['parent:root-a', ['child']]
    ])
    const onRejectedUpdate = vi.fn().mockResolvedValue(false)

    await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'child', bucketKey: 'parent:root-a' },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'root',
        dropIndex: 0,
        dropIndicatorY: 0
      },
      projectGroupById: byId,
      sidebarProjectGroupHeaderIdsByBucket: buckets,
      onCommitProjectGroupUpdate: onRejectedUpdate
    })

    expect(onRejectedUpdate).toHaveBeenCalledTimes(1)
    expect(onRejectedUpdate).toHaveBeenCalledWith('child', { parentGroupId: null, tabOrder: 0 })

    const onAcceptedUpdate = vi.fn().mockResolvedValue(true)
    await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'child', bucketKey: 'parent:root-a' },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'root',
        dropIndex: 0,
        dropIndicatorY: 0
      },
      projectGroupById: byId,
      sidebarProjectGroupHeaderIdsByBucket: buckets,
      onCommitProjectGroupUpdate: onAcceptedUpdate
    })

    expect(onAcceptedUpdate).toHaveBeenCalledTimes(2)
    expect(onAcceptedUpdate).toHaveBeenNthCalledWith(1, 'child', {
      parentGroupId: null,
      tabOrder: 0
    })
    expect(onAcceptedUpdate).toHaveBeenNthCalledWith(2, 'root-a', { tabOrder: 1 })
  })

  it('promotes a subgroup into an interleaved root slot between a root group and a root project with a rank before the project', async () => {
    const rootA = group('root-a', { tabOrder: 0, rootProjectOrder: 0 })
    const child = group('child', { parentGroupId: 'root-a', tabOrder: 0 })
    const rootB = group('root-b', { tabOrder: 1, rootProjectOrder: 10_000 })
    const rootRepo = {
      id: 'repo-r',
      path: '/repo-r',
      displayName: 'Repo R',
      badgeColor: '#000',
      addedAt: 1,
      projectGroupOrder: 1000
    }
    const groups = [rootA, child, rootB]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))
    const groupHeaderRects = [
      {
        groupId: 'root-a',
        bucketKey: 'root',
        headerIndex: 0,
        top: 0,
        bottom: 28,
        sectionBottom: 60
      },
      {
        groupId: 'child',
        bucketKey: 'parent:root-a',
        headerIndex: 0,
        top: 32,
        bottom: 60,
        sectionBottom: 60
      },
      {
        groupId: 'root-b',
        bucketKey: 'root',
        headerIndex: 1,
        top: 100,
        bottom: 128,
        sectionBottom: 128
      }
    ]
    const rootHeaderRects = [
      {
        groupId: 'group:root-a',
        bucketKey: 'root-interleaved',
        headerIndex: 0,
        top: 0,
        bottom: 28,
        sectionBottom: 60
      },
      {
        groupId: 'repo:repo-r',
        bucketKey: 'root-interleaved',
        headerIndex: 1,
        top: 66,
        bottom: 94,
        sectionBottom: 94
      },
      {
        groupId: 'group:root-b',
        bucketKey: 'root-interleaved',
        headerIndex: 2,
        top: 100,
        bottom: 128,
        sectionBottom: 128
      }
    ]
    const buckets = new Map<string, readonly string[]>([
      ['root', ['root-a', 'root-b']],
      ['parent:root-a', ['child']]
    ])

    const target = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 64,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: child,
      projectGroupById: byId,
      reparentableGroupIds: getReparentableTargetGroupIdsForGroup(child, groups),
      groupHeaderRects,
      rootProjectHeaderKeys: ['group:root-a', 'repo:repo-r', 'group:root-b'],
      rootHeaderRects,
      sidebarProjectGroupHeaderIdsByBucket: buckets,
      contentBottom: 128
    })

    expect(target).toMatchObject({
      kind: 'slot',
      targetBucketKey: 'root-interleaved',
      dropIndex: 1
    })

    const onCommitProjectGroupUpdate = vi.fn().mockResolvedValue(true)
    await commitProjectGroupHeaderDragDrop({
      session: {
        groupId: 'child',
        bucketKey: 'parent:root-a',
        rootProjectHeaderKeys: ['group:root-a', 'repo:repo-r', 'group:root-b']
      },
      dropTarget: target!,
      projectGroupById: byId,
      repos: [rootRepo],
      sidebarProjectGroupHeaderIdsByBucket: buckets,
      nextRootProjectOrder: 11_000,
      onCommitProjectGroupUpdate
    })

    expect(onCommitProjectGroupUpdate).toHaveBeenNthCalledWith(1, 'child', {
      parentGroupId: null,
      tabOrder: 1,
      rootProjectOrder: 500
    })
    expect(onCommitProjectGroupUpdate).toHaveBeenNthCalledWith(2, 'root-b', {
      tabOrder: 2
    })
  })

  it('excludes groups on different execution hosts from getReparentableTargetGroupIdsForGroup and respaces tied root ranks on non-interleaved root drops', async () => {
    const localRoot = group('local-root', {
      tabOrder: 0,
      rootProjectOrder: 1000,
      executionHostId: 'local'
    })
    const localChild = group('local-child', {
      parentGroupId: 'local-root',
      tabOrder: 0,
      executionHostId: 'local'
    })
    const sshRoot = group('ssh-root', {
      connectionId: 'box-1',
      executionHostId: 'ssh:box-1',
      tabOrder: 1
    })
    const tiedRepo: Repo = {
      id: 'repo-tied',
      path: '/repo-tied',
      displayName: 'Tied Repo',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local',
      projectGroupId: null,
      projectGroupOrder: 1000
    }
    const groups = [localRoot, localChild, sshRoot]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))

    expect([...getReparentableTargetGroupIdsForGroup(localChild, groups)]).toEqual(['local-root'])

    const onCommitProjectGroupUpdate = vi.fn().mockResolvedValue(true)
    const onCommitRootProjectOrder = vi.fn()
    await commitProjectGroupHeaderDragDrop({
      session: {
        groupId: 'local-child',
        bucketKey: 'parent:local-root'
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'root',
        dropIndex: 1,
        dropIndicatorY: 60
      },
      projectGroupById: byId,
      repos: [tiedRepo],
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['local-root']],
        ['parent:local-root', ['local-child']]
      ]),
      nextRootProjectOrder: 2000,
      onCommitProjectGroupUpdate,
      onCommitRootProjectOrder
    })

    expect(onCommitRootProjectOrder).toHaveBeenCalledWith(
      ['group:local-root', 'group:local-child', 'repo:repo-tied'],
      'group:local-child',
      1
    )
  })

  it('isolates group drag start, same-bucket slot preview, and same-bucket mutations by pin tier', () => {
    const p1 = group('p1', { tabOrder: 0, isPinned: true })
    const p2 = group('p2', { tabOrder: 1, isPinned: true })
    const u1 = group('u1', { tabOrder: 2, isPinned: false })
    const u2 = group('u2', { tabOrder: 3, isPinned: false })

    // Sole pinned + sole unpinned without reparentable targets cannot reorder across pin boundary
    const twoAcrossBoundary = new Map([
      [p1.id, p1],
      [u1.id, u1]
    ])
    expect(
      canProjectGroupStartHeaderDrag({
        group: p1,
        projectGroupById: twoAcrossBoundary,
        sidebarBucketHeaderIds: ['p1', 'u1'],
        reparentableGroupIds: new Set()
      })
    ).toBe(false)

    const allFour = [p1, p2, u1, u2]
    const byId = new Map(allFour.map((entry) => [entry.id, entry]))
    const rects = [
      { groupId: 'p1', bucketKey: 'root', headerIndex: 0, top: 0, bottom: 28, sectionBottom: 28 },
      { groupId: 'p2', bucketKey: 'root', headerIndex: 1, top: 32, bottom: 60, sectionBottom: 60 },
      { groupId: 'u1', bucketKey: 'root', headerIndex: 2, top: 64, bottom: 92, sectionBottom: 92 },
      { groupId: 'u2', bucketKey: 'root', headerIndex: 3, top: 96, bottom: 124, sectionBottom: 124 }
    ]
    const buckets = new Map<string, readonly string[]>([['root', ['p1', 'p2', 'u1', 'u2']]])

    // Dragging unpinned u2 slightly above u1 (y = 61) snaps to dropIndex 0 of unpinned tier (u1.top - 4 = 60)
    const unpinnedTarget = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 61,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: u2,
      projectGroupById: byId,
      reparentableGroupIds: new Set(),
      groupHeaderRects: rects,
      sidebarProjectGroupHeaderIdsByBucket: buckets,
      contentBottom: 124
    })
    expect(unpinnedTarget).toEqual({
      kind: 'slot',
      targetBucketKey: 'root',
      dropIndex: 0,
      dropIndicatorY: 60
    })

    expect(
      getProjectGroupMutationsForDrop({
        draggedGroup: u2,
        sourceBucketKey: 'root',
        dropTarget: unpinnedTarget!,
        projectGroupById: byId,
        sidebarProjectGroupHeaderIdsByBucket: buckets
      })
    ).toEqual([
      { groupId: 'u2', updates: { tabOrder: 2 } },
      { groupId: 'u1', updates: { tabOrder: 3 } }
    ])
  })

  it('targets the destination parent unpinned tier on cross-parent group drops, including pinned-only destinations', () => {
    const p1 = group('p1', { tabOrder: 0, isPinned: true })
    const subPinned = group('sub-pinned', {
      parentGroupId: 'p1',
      tabOrder: 0,
      isPinned: true
    })
    const u1 = group('u1', { tabOrder: 1, isPinned: false })
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

    // 1. Dragging pinned subgroup sub-pinned out to root right above u1 (y = 104) lands in root's unpinned tier (after p1, before u1)
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

    // 2. Dragging root group u1 into p1's direct body (y = 42, above sub-pinned) when p1 only has pinned subgroup sub-pinned anchors BELOW sub-pinned (100 + 4 = 104)
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

    // 3. Promoting a subgroup out to root over a >56px multi-group pinned root prefix (between p1 and p2) snaps to root unpinned slot 0
    const p2 = group('p2', { tabOrder: 1, isPinned: true })
    const uRoot = group('u-root', { tabOrder: 2, isPinned: false })
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

  it('anchors the drop indicator right above the first unpinned project when dropping a group into a subgroup-less group in recent mode', () => {
    const targetParent = group('g-parent', { tabOrder: 0 })
    const draggedRoot = group('g-drag', { tabOrder: 1 })
    const groups = [targetParent, draggedRoot]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))

    const target = computeCombinedProjectGroupHeaderDropTarget({
      pointerY: 110,
      containerTop: 0,
      scrollTop: 0,
      draggedGroup: draggedRoot,
      projectGroupById: byId,
      reparentableGroupIds: getReparentableTargetGroupIdsForGroup(draggedRoot, groups),
      groupHeaderRects: [
        {
          groupId: 'g-parent',
          bucketKey: 'root',
          headerIndex: 0,
          top: 0,
          bottom: 28,
          sectionBottom: 152
        },
        {
          groupId: 'g-drag',
          bucketKey: 'root',
          headerIndex: 1,
          top: 156,
          bottom: 184,
          sectionBottom: 184
        }
      ],
      repoHeaderRects: [
        {
          repoId: 'r-pinned',
          bucketKey: 'group:g-parent',
          headerIndex: 0,
          top: 32,
          bottom: 60,
          sectionBottom: 88
        },
        {
          repoId: 'r-unpinned',
          bucketKey: 'group:g-parent',
          headerIndex: 1,
          top: 92,
          bottom: 120,
          sectionBottom: 152
        }
      ],
      pinnedRepoHeaderIds: new Set(['r-pinned']),
      sidebarProjectGroupHeaderIdsByBucket: new Map([['root', ['g-parent', 'g-drag']]]),
      contentBottom: 184
    })

    expect(target).toEqual({
      kind: 'slot',
      targetBucketKey: 'parent:g-parent',
      dropIndex: 0,
      dropIndicatorY: 88
    })
  })
})
