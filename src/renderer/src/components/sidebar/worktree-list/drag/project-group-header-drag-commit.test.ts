// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { isProjectGroupStillInExpectedParent } from './group-header-hit-geometry'
import {
  collectTargetProjectGroupSiblingIds,
  commitProjectGroupHeaderDragDrop,
  getProjectGroupMutationsForDrop
} from './project-group-header-drag-commit'
import {
  buildProjectGroupRollbackPatch,
  revertAppliedMixedChildRollbacks
} from './project-group-header-drag-rollback'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'local',
    projectGroupOrder: 0,
    ...overrides
  }
}

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

describe('project-group-header-drag-commit', () => {
  it('excludes different exact execution hosts when promoting a subgroup or checking live parent membership', () => {
    const parent = group('local-parent', { tabOrder: 0, executionHostId: 'local' })
    const child = group('local-child', {
      parentGroupId: 'local-parent',
      tabOrder: 0,
      executionHostId: 'local'
    })
    const localRoot = group('local-root', { tabOrder: 1, executionHostId: 'local' })
    const directSshRoot = group('ssh-root', { tabOrder: 0, executionHostId: 'ssh:builder' })
    const groups = [parent, child, localRoot, directSshRoot]
    const byId = new Map(groups.map((entry) => [entry.id, entry]))

    expect(
      collectTargetProjectGroupSiblingIds({
        draggedGroupId: child.id,
        targetParentGroupId: null,
        ownerHostId: 'local',
        seededSiblingIds: ['ssh-root', 'local-parent', 'local-root'],
        projectGroupById: byId
      })
    ).toEqual(['local-parent', 'local-root'])

    const mutations = getProjectGroupMutationsForDrop({
      draggedGroup: child,
      sourceBucketKey: 'parent:local-parent',
      dropTarget: { kind: 'slot', targetBucketKey: 'root', dropIndex: 0, dropIndicatorY: 0 },
      projectGroupById: byId,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['ssh-root', 'local-parent', 'local-root']],
        ['parent:local-parent', ['local-child']]
      ])
    })
    expect(
      mutations.map((entry) => ('groupId' in entry ? entry.groupId : entry.repo.id))
    ).not.toContain('ssh-root')

    expect(
      isProjectGroupStillInExpectedParent({
        groupId: directSshRoot.id,
        expectedParentGroupId: null,
        ownerHostId: 'local',
        liveProjectGroups: groups,
        fallbackProjectGroupById: byId
      })
    ).toBe(false)
  })

  it('stops remaining updates, rolls back applied mutations, skips root respace, and notifies on sibling rejection', async () => {
    const collapsedParent = group('collapsed-parent', {
      tabOrder: 0,
      rootProjectOrder: 1000,
      isCollapsed: true,
      executionHostId: 'local'
    })
    const siblingA = group('sib-a', {
      parentGroupId: 'collapsed-parent',
      tabOrder: 2,
      executionHostId: 'local'
    })
    const siblingB = group('sib-b', {
      parentGroupId: 'collapsed-parent',
      tabOrder: 5,
      executionHostId: 'local'
    })
    const draggedRoot = group('dragged-root', {
      tabOrder: 1,
      rootProjectOrder: 2000,
      executionHostId: 'local'
    })
    const byId = new Map(
      [collapsedParent, siblingA, siblingB, draggedRoot].map((entry) => [entry.id, entry])
    )
    const liveGroups = [collapsedParent, siblingA, siblingB, draggedRoot].map((entry) => ({
      ...entry
    }))
    const calls: { groupId: string; updates: Record<string, unknown> }[] = []
    const onCommitRootProjectOrder = vi.fn()
    const onDropFailed = vi.fn()

    await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'dragged-root', bucketKey: 'root' },
      dropTarget: { kind: 'group-header', groupId: 'collapsed-parent' },
      projectGroupById: byId,
      getLiveProjectGroups: () => liveGroups,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['collapsed-parent', 'dragged-root']]
      ]),
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        calls.push({ groupId, updates })
        if (groupId === 'sib-b') {
          return false
        }
        const target = liveGroups.find((entry) => entry.id === groupId)
        if (target) {
          Object.assign(target, updates)
        }
        return true
      },
      onCommitRootProjectOrder,
      onDropFailed
    })

    expect(calls).toEqual([
      {
        groupId: 'dragged-root',
        updates: { parentGroupId: 'collapsed-parent', tabOrder: 2, rootProjectOrder: null }
      },
      { groupId: 'sib-a', updates: { tabOrder: 0 } },
      { groupId: 'sib-b', updates: { tabOrder: 1 } },
      { groupId: 'sib-a', updates: { tabOrder: 2 } },
      {
        groupId: 'dragged-root',
        updates: { parentGroupId: null, tabOrder: 1, rootProjectOrder: 2000 }
      }
    ])
    expect(onCommitRootProjectOrder).not.toHaveBeenCalled()
    expect(onDropFailed).toHaveBeenCalledTimes(1)
    expect(liveGroups.find((entry) => entry.id === 'dragged-root')?.parentGroupId).toBeNull()
    expect(liveGroups.find((entry) => entry.id === 'sib-a')?.tabOrder).toBe(2)
  })

  it('preserves persisted sibling order when non-root target has partially seeded headers', () => {
    const parent = group('parent', { tabOrder: 0, executionHostId: 'local' })
    const sibA = group('sib-a', { parentGroupId: 'parent', tabOrder: 0, executionHostId: 'local' })
    const sibB = group('sib-b', { parentGroupId: 'parent', tabOrder: 1, executionHostId: 'local' })
    const dragged = group('dragged', { tabOrder: 2, executionHostId: 'local' })
    const byId = new Map([parent, sibA, sibB, dragged].map((entry) => [entry.id, entry]))

    expect(
      collectTargetProjectGroupSiblingIds({
        draggedGroupId: dragged.id,
        targetParentGroupId: 'parent',
        ownerHostId: 'local',
        seededSiblingIds: ['sib-b'],
        projectGroupById: byId
      })
    ).toEqual(['sib-a', 'sib-b'])

    const mutations = getProjectGroupMutationsForDrop({
      draggedGroup: dragged,
      sourceBucketKey: 'root',
      dropTarget: { kind: 'group-header', groupId: 'parent' },
      projectGroupById: byId,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['parent', 'dragged']],
        ['parent:parent', ['sib-b']]
      ])
    })
    expect(mutations).toEqual([
      { groupId: 'dragged', updates: { parentGroupId: 'parent', tabOrder: 2 } }
    ])
  })

  it('refreshes live project groups and repos between rollback steps', async () => {
    const parentP = group('p', { tabOrder: 0, executionHostId: 'local' })
    const parentQ = group('q', { tabOrder: 1, executionHostId: 'local' })
    const sibA = group('sib-a', { parentGroupId: 'p', tabOrder: 0, executionHostId: 'local' })
    const groupD = group('d', { parentGroupId: 'p', tabOrder: 1, executionHostId: 'local' })
    const repoE = repo('repo-e', { projectGroupId: 'p', projectGroupOrder: 1 })
    let liveGroups = [parentP, parentQ, sibA, groupD]
    let liveRepos = [repoE]
    const fallbackGroupById = new Map(liveGroups.map((entry) => [entry.id, entry]))
    const fallbackRepoById = new Map(liveRepos.map((entry) => [entry.id, entry]))
    const rollbackGroupCalls: string[] = []
    const rollbackRepoCalls: string[] = []

    const reverted = await revertAppliedMixedChildRollbacks({
      appliedRollbacks: [
        {
          kind: 'group',
          groupId: 'd',
          patch: { parentGroupId: null, tabOrder: 1 },
          expectedLiveParentGroupId: 'p'
        },
        {
          kind: 'repo',
          repo: repoE,
          previousProjectGroupId: null,
          previousOrder: 0,
          previousIsPinned: false,
          expectedLiveProjectGroupId: 'p',
          expectedLiveOrder: 1
        },
        {
          kind: 'group',
          groupId: 'sib-a',
          patch: { tabOrder: 2 },
          expectedLiveParentGroupId: 'p'
        }
      ],
      ownerHostId: 'local',
      getLiveProjectGroups: () => liveGroups,
      getLiveRepos: () => liveRepos,
      fallbackProjectGroupById: fallbackGroupById,
      fallbackRepoById,
      onCommitProjectGroupUpdate: async (groupId) => {
        rollbackGroupCalls.push(groupId)
        if (groupId === 'sib-a') {
          liveGroups = [parentP, parentQ, sibA, { ...groupD, parentGroupId: 'q' }]
          liveRepos = [{ ...repoE, projectGroupId: 'q' }]
        }
        return true
      },
      onCommitProjectGroupOrder: async (targetRepo) => {
        rollbackRepoCalls.push(targetRepo.id)
        return true
      }
    })

    expect(reverted).toBe(true)
    expect(rollbackGroupCalls).toEqual(['sib-a'])
    expect(rollbackRepoCalls).toEqual([])
  })

  it('stops rollback, reconciles host groups, and returns false when a rollback step rejects', async () => {
    const parent = group('collapsed-parent', {
      tabOrder: 0,
      isCollapsed: true,
      executionHostId: 'local'
    })
    const sibA = group('sib-a', {
      parentGroupId: 'collapsed-parent',
      tabOrder: 2,
      executionHostId: 'local'
    })
    const sibB = group('sib-b', {
      parentGroupId: 'collapsed-parent',
      tabOrder: 5,
      executionHostId: 'local'
    })
    const sibC = group('sib-c', {
      parentGroupId: 'collapsed-parent',
      tabOrder: 8,
      executionHostId: 'local'
    })
    const dragged = group('dragged-root', { tabOrder: 1, isPinned: true, executionHostId: 'local' })
    const byId = new Map([parent, sibA, sibB, sibC, dragged].map((entry) => [entry.id, entry]))
    const liveGroups = [parent, sibA, sibB, sibC, dragged].map((entry) => ({ ...entry }))
    const calls: { groupId: string; updates: Record<string, unknown> }[] = []
    const onReconcileHostProjectGroups = vi.fn()
    const onDropFailed = vi.fn()

    const committed = await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'dragged-root', bucketKey: 'root' },
      dropTarget: { kind: 'group-header', groupId: 'collapsed-parent' },
      projectGroupById: byId,
      getLiveProjectGroups: () => liveGroups,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['collapsed-parent', 'dragged-root']]
      ]),
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        calls.push({ groupId, updates })
        if (groupId === 'sib-c') {
          throw new Error('persist failed')
        }
        if (groupId === 'sib-b' && updates.tabOrder === 5) {
          return false
        }
        const target = liveGroups.find((entry) => entry.id === groupId)
        if (target) {
          Object.assign(target, updates)
        }
        return true
      },
      onReconcileHostProjectGroups,
      onDropFailed
    })

    expect(committed).toBe(false)
    expect(calls).toEqual([
      { groupId: 'dragged-root', updates: { parentGroupId: 'collapsed-parent', tabOrder: 3 } },
      { groupId: 'sib-a', updates: { tabOrder: 0 } },
      { groupId: 'sib-b', updates: { tabOrder: 1 } },
      { groupId: 'sib-c', updates: { tabOrder: 2 } },
      { groupId: 'sib-b', updates: { tabOrder: 5 } }
    ])
    expect(onReconcileHostProjectGroups).toHaveBeenCalledWith('local')
    expect(onDropFailed).toHaveBeenCalledTimes(1)
  })

  it('maps visible non-root dropIndex to anchor sibling when hidden siblings precede visible ones', () => {
    const parent = group('parent', { tabOrder: 0, executionHostId: 'local' })
    const hiddenFirst = group('hidden-first', {
      parentGroupId: 'parent',
      tabOrder: 0,
      executionHostId: 'local'
    })
    const visibleFirst = group('visible-first', {
      parentGroupId: 'parent',
      tabOrder: 1,
      executionHostId: 'local'
    })
    const visibleSecond = group('visible-second', {
      parentGroupId: 'parent',
      tabOrder: 2,
      executionHostId: 'local'
    })
    const dragged = group('dragged', { tabOrder: 5, executionHostId: 'local' })
    const byId = new Map(
      [parent, hiddenFirst, visibleFirst, visibleSecond, dragged].map((entry) => [entry.id, entry])
    )

    const mutations = getProjectGroupMutationsForDrop({
      draggedGroup: dragged,
      sourceBucketKey: 'root',
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'parent:parent',
        dropIndex: 1,
        dropIndicatorY: 42
      },
      projectGroupById: byId,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['parent', 'dragged']],
        ['parent:parent', ['visible-first', 'visible-second']]
      ])
    })

    // Visual slot 1 (between visible-first and visible-second) inserts before visible-second (index 2).
    expect(mutations).toEqual([
      { groupId: 'dragged', updates: { parentGroupId: 'parent', tabOrder: 2 } },
      { groupId: 'visible-second', updates: { tabOrder: 3 } }
    ])
  })

  it('maps visible non-root unpinned dropIndex past pinned siblings when hidden unpinned siblings exist', () => {
    const parent = group('parent', { tabOrder: 0, executionHostId: 'local' })
    const pinnedSib = group('pinned-sib', {
      parentGroupId: 'parent',
      tabOrder: 0,
      isPinned: true,
      executionHostId: 'local'
    })
    const hiddenUnpinned = group('hidden-unpinned', {
      parentGroupId: 'parent',
      tabOrder: 1,
      executionHostId: 'local'
    })
    const visibleUnpinned = group('visible-unpinned', {
      parentGroupId: 'parent',
      tabOrder: 2,
      executionHostId: 'local'
    })
    const dragged = group('dragged', { tabOrder: 5, executionHostId: 'local' })
    const byId = new Map(
      [parent, pinnedSib, hiddenUnpinned, visibleUnpinned, dragged].map((entry) => [
        entry.id,
        entry
      ])
    )

    const mutations = getProjectGroupMutationsForDrop({
      draggedGroup: dragged,
      sourceBucketKey: 'root',
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'parent:parent',
        dropIndex: 0,
        dropIndicatorY: 42
      },
      projectGroupById: byId,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['parent', 'dragged']],
        ['parent:parent', ['pinned-sib', 'visible-unpinned']]
      ])
    })

    expect(mutations).toEqual([
      { groupId: 'dragged', updates: { parentGroupId: 'parent', tabOrder: 2 } },
      { groupId: 'visible-unpinned', updates: { tabOrder: 3 } }
    ])
  })

  it('stops rollback, reconciles host groups, and returns false when a rollback step throws synchronously', async () => {
    const parent = group('collapsed-parent', {
      tabOrder: 0,
      isCollapsed: true,
      executionHostId: 'local'
    })
    const sibA = group('sib-a', {
      parentGroupId: 'collapsed-parent',
      tabOrder: 2,
      executionHostId: 'local'
    })
    const sibB = group('sib-b', {
      parentGroupId: 'collapsed-parent',
      tabOrder: 5,
      executionHostId: 'local'
    })
    const dragged = group('dragged-root', { tabOrder: 1, executionHostId: 'local' })
    const byId = new Map([parent, sibA, sibB, dragged].map((entry) => [entry.id, entry]))
    const liveGroups = [parent, sibA, sibB, dragged].map((entry) => ({ ...entry }))
    const onReconcileHostProjectGroups = vi.fn()
    const onDropFailed = vi.fn()

    const committed = await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'dragged-root', bucketKey: 'root' },
      dropTarget: { kind: 'group-header', groupId: 'collapsed-parent' },
      projectGroupById: byId,
      getLiveProjectGroups: () => liveGroups,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['collapsed-parent', 'dragged-root']]
      ]),
      onCommitProjectGroupUpdate: (groupId, updates) => {
        if (groupId === 'sib-b') {
          return Promise.resolve(false)
        }
        if (groupId === 'sib-a' && updates.tabOrder === 2) {
          throw new Error('sync rollback throw')
        }
        const target = liveGroups.find((entry) => entry.id === groupId)
        if (target) {
          Object.assign(target, updates)
        }
        return Promise.resolve(true)
      },
      onReconcileHostProjectGroups,
      onDropFailed
    })

    expect(committed).toBe(false)
    expect(onReconcileHostProjectGroups).toHaveBeenCalledWith('local')
    expect(onDropFailed).toHaveBeenCalledTimes(1)
  })

  it('skips rolling back a group whose live tabOrder changed in the same parent from a newer reorder', async () => {
    const parent = group('target-parent', { tabOrder: 0, executionHostId: 'local' })
    const dragged = group('dragged', {
      parentGroupId: 'target-parent',
      tabOrder: 2,
      executionHostId: 'local'
    })
    const sib1 = group('sib-1', {
      parentGroupId: 'target-parent',
      tabOrder: 0,
      executionHostId: 'local'
    })
    const sib2 = group('sib-2', {
      parentGroupId: 'target-parent',
      tabOrder: 1,
      executionHostId: 'local'
    })
    const byId = new Map([parent, dragged, sib1, sib2].map((entry) => [entry.id, entry]))
    const liveGroups = [parent, dragged, sib1, sib2].map((entry) => ({ ...entry }))
    const rollbackWrites: { groupId: string; updates: Record<string, unknown> }[] = []

    const committed = await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'dragged', bucketKey: 'parent:target-parent' },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'parent:target-parent',
        dropIndex: 0,
        dropIndicatorY: 20
      },
      projectGroupById: byId,
      getLiveProjectGroups: () => liveGroups,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['parent:target-parent', ['sib-1', 'sib-2', 'dragged']]
      ]),
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        rollbackWrites.push({ groupId, updates })
        const target = liveGroups.find((entry) => entry.id === groupId)
        if (groupId === 'dragged' && updates.tabOrder === 0) {
          if (target) {
            target.tabOrder = 0
          }
          return true
        }
        if (groupId === 'sib-1') {
          // Newer reorder updates dragged.tabOrder to 7 inside the same parent before sib-1 fails.
          const liveDragged = liveGroups.find((entry) => entry.id === 'dragged')
          if (liveDragged) {
            liveDragged.tabOrder = 7
          }
          return false
        }
        if (target) {
          Object.assign(target, updates)
        }
        return true
      }
    })

    expect(committed).toBe(false)
    expect(rollbackWrites).toEqual([
      { groupId: 'dragged', updates: { tabOrder: 0 } },
      { groupId: 'sib-1', updates: { tabOrder: 1 } }
    ])
    expect(liveGroups.find((entry) => entry.id === 'dragged')?.tabOrder).toBe(7)
  })

  it('restores rootProjectOrder when rolling back a failed root-to-subgroup reparenting', async () => {
    const targetParent = group('target-parent', {
      parentGroupId: null,
      tabOrder: 0,
      executionHostId: 'local'
    })
    const dragged = group('dragged', {
      parentGroupId: null,
      tabOrder: 1,
      rootProjectOrder: 1500,
      executionHostId: 'local'
    })
    const sib = group('sib', {
      parentGroupId: 'target-parent',
      tabOrder: 0,
      executionHostId: 'local'
    })
    const liveGroups = [targetParent, dragged, sib].map((entry) => ({ ...entry }))
    const calls: { groupId: string; updates: Record<string, unknown> }[] = []

    expect(
      buildProjectGroupRollbackPatch(dragged, { parentGroupId: 'target-parent', tabOrder: 0 })
    ).toEqual({
      parentGroupId: null,
      rootProjectOrder: 1500,
      tabOrder: 1
    })

    const committed = await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'dragged', bucketKey: 'root' },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'parent:target-parent',
        dropIndex: 0,
        dropIndicatorY: 20
      },
      projectGroupById: new Map(liveGroups.map((entry) => [entry.id, entry])),
      getLiveProjectGroups: () => liveGroups,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['target-parent', 'dragged']],
        ['parent:target-parent', ['sib']]
      ]),
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        calls.push({ groupId, updates })
        const target = liveGroups.find((entry) => entry.id === groupId)
        if (groupId === 'dragged' && updates.parentGroupId === 'target-parent') {
          if (target) {
            target.parentGroupId = 'target-parent'
            target.tabOrder = updates.tabOrder ?? target.tabOrder
            delete target.rootProjectOrder
          }
          return true
        }
        return groupId === 'dragged'
      }
    })

    expect(committed).toBe(false)
    expect(calls).toEqual([
      {
        groupId: 'dragged',
        updates: { parentGroupId: 'target-parent', rootProjectOrder: null, tabOrder: 0 }
      },
      { groupId: 'sib', updates: { tabOrder: 1 } },
      {
        groupId: 'dragged',
        updates: { parentGroupId: null, tabOrder: 1, rootProjectOrder: 1500 }
      }
    ])
  })

  it('rolls back a promoted group when awaited root interleaved respace fails', async () => {
    const parent = group('p', { tabOrder: 0, executionHostId: 'local' })
    const g1 = group('g1', { tabOrder: 1, rootProjectOrder: 1, executionHostId: 'local' })
    const g2 = group('g2', {
      tabOrder: 2,
      rootProjectOrder: 1 + Number.EPSILON,
      executionHostId: 'local'
    })
    const dragged = group('dragged', {
      parentGroupId: 'p',
      tabOrder: 0,
      executionHostId: 'local'
    })
    const liveGroups = [parent, g1, g2, dragged].map((entry) => ({ ...entry }))
    const updatesLog: { groupId: string; updates: Record<string, unknown> }[] = []
    const onDropFailed = vi.fn()

    const committed = await commitProjectGroupHeaderDragDrop({
      session: {
        groupId: 'dragged',
        bucketKey: 'parent:p',
        rootProjectHeaderKeys: ['group:g1', 'group:g2']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'root-interleaved',
        dropIndex: 1,
        dropIndicatorY: 40
      },
      projectGroupById: new Map(liveGroups.map((entry) => [entry.id, entry])),
      getLiveProjectGroups: () => liveGroups,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['p', 'g1', 'g2']],
        ['parent:p', ['dragged']]
      ]),
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        updatesLog.push({ groupId, updates })
        const target = liveGroups.find((entry) => entry.id === groupId)
        if (target) {
          if (updates.parentGroupId !== undefined) {
            target.parentGroupId = updates.parentGroupId
          }
          if (updates.tabOrder !== undefined) {
            target.tabOrder = updates.tabOrder
          }
          if (updates.rootProjectOrder === null) {
            delete target.rootProjectOrder
          } else if (updates.rootProjectOrder !== undefined) {
            target.rootProjectOrder = updates.rootProjectOrder
          }
        }
        return true
      },
      onCommitRootProjectOrder: async () => false,
      onDropFailed
    })

    expect(committed).toBe(false)
    expect(updatesLog).toEqual([
      {
        groupId: 'dragged',
        updates: { parentGroupId: null, rootProjectOrder: 1, tabOrder: 1 }
      },
      { groupId: 'g1', updates: { tabOrder: 2 } },
      { groupId: 'g2', updates: { tabOrder: 3 } },
      { groupId: 'g2', updates: { tabOrder: 2 } },
      { groupId: 'g1', updates: { tabOrder: 1 } },
      {
        groupId: 'dragged',
        updates: { parentGroupId: 'p', tabOrder: 0, rootProjectOrder: null }
      }
    ])
    expect(onDropFailed).toHaveBeenCalledTimes(1)
  })

  it('awaits onCommitRootProjectOrder and forwards rootProjectHeaderHostId for root interleaved group drops', async () => {
    const g1 = group('g1', { tabOrder: 0, executionHostId: 'runtime:env-1' })
    const g2 = group('g2', { tabOrder: 1, executionHostId: 'runtime:env-1' })
    const calls: {
      keys: readonly string[]
      draggedKey: string
      dropIndex: number
      hostId?: string
    }[] = []

    const committed = await commitProjectGroupHeaderDragDrop({
      session: {
        groupId: 'g1',
        bucketKey: 'root',
        rootProjectHeaderKeys: ['group:g1', 'group:g2'],
        rootProjectHeaderHostId: 'runtime:env-1'
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'root-interleaved',
        dropIndex: 2,
        dropIndicatorY: 60
      },
      projectGroupById: new Map([
        ['g1', g1],
        ['g2', g2]
      ]),
      sidebarProjectGroupHeaderIdsByBucket: new Map([['root', ['g1', 'g2']]]),
      onCommitProjectGroupUpdate: async () => true,
      onCommitRootProjectOrder: async (keys, draggedKey, dropIndex, hostId) => {
        calls.push({ keys, draggedKey, dropIndex, hostId })
        return false
      }
    })

    expect(committed).toBe(false)
    expect(calls).toEqual([
      {
        keys: ['group:g1', 'group:g2'],
        draggedKey: 'group:g1',
        dropIndex: 2,
        hostId: 'runtime:env-1'
      }
    ])
  })

  it('treats a parentGroupId referencing another host group as missing in fallback parent checks', () => {
    const foreignParent = group('shared-parent', { tabOrder: 0, executionHostId: 'runtime:remote' })
    const localChild = group('local-child', {
      parentGroupId: 'shared-parent',
      tabOrder: 1,
      executionHostId: 'local'
    })
    const dragged = group('local-dragged', { tabOrder: 2, executionHostId: 'local' })
    const byId = new Map<string, ProjectGroup>([
      [foreignParent.id, foreignParent],
      [localChild.id, localChild],
      [dragged.id, dragged]
    ])

    expect(
      collectTargetProjectGroupSiblingIds({
        draggedGroupId: 'local-dragged',
        targetParentGroupId: null,
        ownerHostId: 'local',
        seededSiblingIds: ['local-dragged'],
        projectGroupById: byId
      })
    ).toEqual(['local-child'])

    expect(
      isProjectGroupStillInExpectedParent({
        groupId: 'local-child',
        expectedParentGroupId: null,
        ownerHostId: 'local',
        liveProjectGroups: undefined,
        fallbackProjectGroupById: byId
      })
    ).toBe(true)
  })

  it('restores group pin state when rolling back a failed parent change', async () => {
    const parent = group('collapsed-parent', {
      tabOrder: 0,
      isCollapsed: true,
      executionHostId: 'local'
    })
    const sibA = group('sib-a', {
      parentGroupId: 'collapsed-parent',
      tabOrder: 5,
      executionHostId: 'local'
    })
    const dragged = group('pinned-dragged', {
      tabOrder: 1,
      isPinned: true,
      executionHostId: 'local'
    })
    const byId = new Map([parent, sibA, dragged].map((entry) => [entry.id, entry]))
    const liveGroups = [parent, sibA, dragged].map((entry) => ({ ...entry }))
    const calls: { groupId: string; updates: Record<string, unknown> }[] = []
    const onDropFailed = vi.fn()

    const committed = await commitProjectGroupHeaderDragDrop({
      session: { groupId: 'pinned-dragged', bucketKey: 'root' },
      dropTarget: { kind: 'group-header', groupId: 'collapsed-parent' },
      projectGroupById: byId,
      getLiveProjectGroups: () => liveGroups,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['pinned-dragged', 'collapsed-parent']]
      ]),
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        calls.push({ groupId, updates })
        if (groupId === 'sib-a') {
          return false
        }
        const target = liveGroups.find((entry) => entry.id === groupId)
        if (target) {
          Object.assign(target, updates)
          if (updates.parentGroupId !== undefined && updates.isPinned === undefined) {
            target.isPinned = false
          }
        }
        return true
      },
      onDropFailed
    })

    expect(committed).toBe(false)
    expect(calls).toEqual([
      { groupId: 'pinned-dragged', updates: { parentGroupId: 'collapsed-parent', tabOrder: 1 } },
      { groupId: 'sib-a', updates: { tabOrder: 0 } },
      {
        groupId: 'pinned-dragged',
        updates: { parentGroupId: null, rootProjectOrder: null, tabOrder: 1, isPinned: true }
      }
    ])
    expect(liveGroups.find((entry) => entry.id === 'pinned-dragged')?.isPinned).toBe(true)
    expect(onDropFailed).toHaveBeenCalledTimes(1)
  })
})
