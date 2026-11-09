// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { ROOT_INTERLEAVED_GROUP_BUCKET_KEY } from './project-group-header-drag-contract'
import {
  canProjectGroupStartHeaderDrag,
  computeCombinedProjectGroupHeaderDropTarget,
  getReparentableTargetGroupIdsForGroup
} from './project-group-header-reparent-drop'
import {
  commitProjectGroupHeaderDragDrop,
  getProjectGroupMutationsForDrop
} from './project-group-header-drag-commit'
import { getRootProjectOrderUpdatesForSidebarDrop } from './root-project-header-drop'

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

    const committedGroups = groups.map((entry) => ({ ...entry }))
    const onCommitProjectGroupUpdate = vi.fn(
      async (groupId: string, updates: Record<string, unknown>) => {
        const targetGroup = committedGroups.find((entry) => entry.id === groupId)
        if (targetGroup) {
          Object.assign(targetGroup, updates)
        }
        return true
      }
    )
    let respaceUpdates: ReturnType<typeof getRootProjectOrderUpdatesForSidebarDrop> = []
    const onCommitRootProjectOrder = vi.fn(
      (visibleKeys: readonly string[], draggedKey: string, dropIndex: number) => {
        respaceUpdates = getRootProjectOrderUpdatesForSidebarDrop({
          repos: [tiedRepo],
          projectGroups: committedGroups,
          visibleKeys,
          draggedKey,
          dropIndex
        })
      }
    )
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

    expect(onCommitRootProjectOrder).toHaveBeenCalledTimes(1)
    expect(
      respaceUpdates.map((entry) => ({
        key:
          entry.entry.kind === 'group'
            ? `group:${entry.entry.group.id}`
            : `repo:${entry.entry.repo.id}`,
        order: entry.rootProjectOrder
      }))
    ).toEqual([
      { key: 'group:local-child', order: 2000 },
      { key: 'repo:repo-tied', order: 3000 }
    ])
  })

  it('appends after hidden children when dropping onto a collapsed parent group header', () => {
    const collapsedParent = group('collapsed-parent', {
      tabOrder: 0,
      isCollapsed: true,
      executionHostId: 'local'
    })
    const hiddenFirst = group('hidden-first', {
      parentGroupId: 'collapsed-parent',
      tabOrder: 2,
      executionHostId: 'local'
    })
    const hiddenSecond = group('hidden-second', {
      parentGroupId: 'collapsed-parent',
      tabOrder: 5,
      executionHostId: 'local'
    })
    const dragged = group('dragged-root', {
      tabOrder: 1,
      rootProjectOrder: 1000,
      executionHostId: 'local'
    })
    const groups = [collapsedParent, hiddenSecond, hiddenFirst, dragged]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))

    const mutations = getProjectGroupMutationsForDrop({
      draggedGroup: dragged,
      sourceBucketKey: 'root',
      dropTarget: { kind: 'group-header', groupId: 'collapsed-parent' },
      projectGroupById: byId,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['collapsed-parent', 'dragged-root']]
      ])
    })

    expect(mutations).toEqual([
      { groupId: 'hidden-first', updates: { tabOrder: 0 } },
      { groupId: 'hidden-second', updates: { tabOrder: 1 } },
      {
        groupId: 'dragged-root',
        updates: { parentGroupId: 'collapsed-parent', tabOrder: 2, rootProjectOrder: null }
      }
    ])
  })

  it('skips sibling tabOrder patches when a sibling moves out while reparent is pending and respaces precision-exhausted root slots', async () => {
    const parentP = group('parent-p', { tabOrder: 0, executionHostId: 'local' })
    const parentQ = group('parent-q', { tabOrder: 1, executionHostId: 'local' })
    const siblingMoved = group('sib-moved', {
      parentGroupId: 'parent-p',
      tabOrder: 5,
      executionHostId: 'local'
    })
    const siblingKept = group('sib-kept', {
      parentGroupId: 'parent-p',
      tabOrder: 8,
      executionHostId: 'local'
    })
    const dragged = group('dragged', { tabOrder: 2, executionHostId: 'local' })
    let liveGroups = [parentP, parentQ, siblingMoved, siblingKept, dragged]
    const committed: { groupId: string; updates: unknown }[] = []

    await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'dragged', bucketKey: 'root' },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'parent:parent-p',
        dropIndex: 0,
        dropIndicatorY: 0
      },
      projectGroupById: new Map(liveGroups.map((entry) => [entry.id, entry])),
      getLiveProjectGroups: () => liveGroups,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['parent-p', 'parent-q', 'dragged']],
        ['parent:parent-p', ['sib-moved', 'sib-kept']]
      ]),
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        committed.push({ groupId, updates })
        if (groupId === 'dragged') {
          liveGroups = liveGroups.map((entry) =>
            entry.id === 'sib-moved' ? { ...entry, parentGroupId: 'parent-q', tabOrder: 5 } : entry
          )
        }
        return true
      }
    })

    expect(committed).toEqual([
      { groupId: 'dragged', updates: { parentGroupId: 'parent-p', tabOrder: 0 } },
      { groupId: 'sib-kept', updates: { tabOrder: 2 } }
    ])

    const r1: Repo = {
      id: 'r-eps-1',
      path: '/r-eps-1',
      displayName: 'r-eps-1',
      badgeColor: '#000',
      addedAt: 1,
      projectGroupOrder: 1,
      executionHostId: 'local'
    }
    const r2: Repo = {
      ...r1,
      id: 'r-eps-2',
      path: '/r-eps-2',
      projectGroupOrder: 1 + Number.EPSILON
    }
    const child = group('eps-child', {
      parentGroupId: 'parent-p',
      tabOrder: 0,
      executionHostId: 'local'
    })
    const onCommitRootProjectOrder = vi.fn()
    await commitProjectGroupHeaderDragDrop({
      session: {
        groupId: 'eps-child',
        bucketKey: 'parent:parent-p',
        rootProjectHeaderKeys: ['repo:r-eps-1', 'repo:r-eps-2']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: ROOT_INTERLEAVED_GROUP_BUCKET_KEY,
        dropIndex: 1,
        dropIndicatorY: 0
      },
      projectGroupById: new Map([
        ['parent-p', parentP],
        ['eps-child', child]
      ]),
      repos: [r1, r2],
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['parent-p']],
        ['parent:parent-p', ['eps-child']]
      ]),
      onCommitProjectGroupUpdate: async () => true,
      onCommitRootProjectOrder
    })
    expect(onCommitRootProjectOrder).toHaveBeenCalledTimes(1)
  })

  it('matches exact host-twin repo rows and skips removed repos when validating live sibling repo mutations', async () => {
    const sshParent = group('g-ssh', {
      connectionId: 'box',
      executionHostId: 'ssh:box',
      tabOrder: 0
    })
    const dragged = group('g-drag-ssh', {
      connectionId: 'box',
      executionHostId: 'ssh:box',
      tabOrder: 1
    })
    const localTwin: Repo = {
      id: 'r1',
      path: '/r1',
      displayName: 'r1',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local',
      projectGroupId: null
    }
    const sshTwin: Repo = {
      ...localTwin,
      connectionId: 'box',
      executionHostId: 'ssh:box',
      projectGroupId: 'g-ssh'
    }
    const removedRepo: Repo = { ...sshTwin, id: 'r2', path: '/r2', displayName: 'r2' }
    let liveRepos = [localTwin, sshTwin, removedRepo]
    const committedRepoIds: string[] = []

    await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'g-drag-ssh', bucketKey: 'root' },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'parent:g-ssh',
        dropIndex: 0,
        dropIndicatorY: 0
      },
      projectGroupById: new Map([
        ['g-ssh', sshParent],
        ['g-drag-ssh', dragged]
      ]),
      getLiveProjectGroups: () => [sshParent, { ...dragged, parentGroupId: 'g-ssh' }],
      getLiveRepos: () => liveRepos,
      repos: [localTwin, sshTwin, removedRepo],
      repoById: new Map([
        ['r1', sshTwin],
        ['r2', removedRepo]
      ]),
      allowMixedProjectReorder: true,
      sidebarGroupChildItemIdsByGroupId: new Map([['g-ssh', ['repo:r1', 'repo:r2'] as const]]),
      sidebarProjectGroupHeaderIdsByBucket: new Map([['root', ['g-ssh', 'g-drag-ssh']]]),
      onCommitProjectGroupUpdate: async () => {
        liveRepos = [localTwin, sshTwin]
        return true
      },
      onCommitProjectGroupOrder: async (repo) => {
        committedRepoIds.push(`${repo.id}@${repo.executionHostId}`)
        return true
      }
    })

    expect(committedRepoIds).toEqual(['r1@ssh:box'])
  })
})
