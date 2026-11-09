import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { executeOrderedDropMutations } from './project-group-header-drag-rollback'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'

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
    ...overrides
  }
}

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

describe('mixed-child ordered mutation rollbacks', () => {
  it('preserves undefined projectGroupOrder (passes null) when rolling back a legacy unranked repo', async () => {
    const parent = makeGroup('g1')
    const legacyRepo = makeRepo('r-legacy', { projectGroupId: 'g1' })
    const draggedRepo = makeRepo('r-drag', { projectGroupId: null, projectGroupOrder: 2 })
    const liveRepos = [legacyRepo, draggedRepo]
    const repoOrderCalls: { id: string; groupId: string | null; order: number | null }[] = []
    const primaryMutation = {
      kind: 'repo' as const,
      repo: draggedRepo,
      projectGroupId: 'g1',
      order: 0
    }

    const ok = await executeOrderedDropMutations({
      primaryMutation,
      mutations: [
        primaryMutation,
        { kind: 'repo', repo: legacyRepo, projectGroupId: 'g1', order: 1 },
        { kind: 'group', groupId: 'g-fail', updates: { tabOrder: 2 } }
      ],
      expectedParentGroupId: 'g1',
      ownerHostId: 'local',
      projectGroupById: new Map([
        ['g1', parent],
        ['g-fail', makeGroup('g-fail', { parentGroupId: 'g1', tabOrder: 5 })]
      ]),
      repoById: new Map([
        ['r-legacy', legacyRepo],
        ['r-drag', draggedRepo]
      ]),
      getLiveProjectGroups: () => [
        parent,
        makeGroup('g-fail', { parentGroupId: 'g1', tabOrder: 5 })
      ],
      getLiveRepos: () => liveRepos,
      onCommitProjectGroupUpdate: async () => false,
      onCommitProjectGroupOrder: async (repo, groupId, order) => {
        repoOrderCalls.push({ id: repo.id, groupId, order })
        const match = liveRepos.find((r) => r.id === repo.id)
        if (match) {
          match.projectGroupId = groupId
          match.projectGroupOrder = order ?? undefined
        }
        return true
      },
      onDropFailed: vi.fn()
    })

    expect(ok).toBe(false)
    expect(repoOrderCalls).toEqual([
      { id: 'r-drag', groupId: 'g1', order: 0 },
      { id: 'r-legacy', groupId: 'g1', order: 1 },
      { id: 'r-legacy', groupId: 'g1', order: null },
      { id: 'r-drag', groupId: null, order: 2 }
    ])
  })

  it('snapshots live pre-write rank right before each mutation and skips reverting entries moved concurrently', async () => {
    const parent = makeGroup('g1')
    const subA = makeGroup('sub-a', { parentGroupId: 'g1', tabOrder: 0 })
    const subB = makeGroup('sub-b', { parentGroupId: 'g1', tabOrder: 1 })
    const repoS = makeRepo('r-s', { projectGroupId: 'g1', projectGroupOrder: 2 })
    const repoFail = makeRepo('r-fail', { projectGroupId: 'g1', projectGroupOrder: 4 })
    const liveGroups = [parent, subA, subB]
    const liveRepos = [repoS, repoFail]
    const groupCalls: {
      id: string
      updates: { tabOrder?: number; parentGroupId?: string | null }
    }[] = []
    const repoCalls: { id: string; groupId: string | null; order: number | null }[] = []

    const ok = await executeOrderedDropMutations({
      mutations: [
        { kind: 'group', groupId: 'sub-a', updates: { tabOrder: 10 } },
        { kind: 'group', groupId: 'sub-b', updates: { tabOrder: 11 } },
        { kind: 'repo', repo: repoS, projectGroupId: 'g1', order: 12 },
        { kind: 'repo', repo: repoFail, projectGroupId: 'g1', order: 13 }
      ],
      expectedParentGroupId: 'g1',
      ownerHostId: 'local',
      projectGroupById: new Map(liveGroups.map((g) => [g.id, g])),
      repoById: new Map(liveRepos.map((r) => [r.id, r])),
      getLiveProjectGroups: () => liveGroups,
      getLiveRepos: () => liveRepos,
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        groupCalls.push({ id: groupId, updates })
        const match = liveGroups.find((g) => g.id === groupId)
        if (match && updates.tabOrder !== undefined) {
          match.tabOrder = updates.tabOrder
        }
        // While committing sub-a, another writer bumps sub-b's rank from 1 -> 7 before sub-b is written.
        if (groupId === 'sub-a' && updates.tabOrder === 10) {
          subB.tabOrder = 7
        }
        return true
      },
      onCommitProjectGroupOrder: async (repo, groupId, order) => {
        repoCalls.push({ id: repo.id, groupId, order })
        if (repo.id === 'r-fail') {
          // Before rolling back, external reorder updates sub-a live tabOrder from 10 -> 99.
          subA.tabOrder = 99
          return false
        }
        const match = liveRepos.find((r) => r.id === repo.id)
        if (match) {
          match.projectGroupOrder = order ?? undefined
        }
        return true
      },
      onDropFailed: vi.fn()
    })

    expect(ok).toBe(false)
    // sub-b rolls back to 7 (fresh snapshot before its write), sub-a rollback is skipped (live tabOrder became 99 != 10), r-s rolls back 12 -> 2.
    expect(groupCalls).toEqual([
      { id: 'sub-a', updates: { tabOrder: 10 } },
      { id: 'sub-b', updates: { tabOrder: 11 } },
      { id: 'sub-b', updates: { tabOrder: 7 } }
    ])
    expect(repoCalls).toEqual([
      { id: 'r-s', groupId: 'g1', order: 12 },
      { id: 'r-fail', groupId: 'g1', order: 13 },
      { id: 'r-s', groupId: 'g1', order: 2 }
    ])
  })

  it('restores pinned repo membership and order when primary move returns false after clearing group and pin', async () => {
    const targetParent = makeGroup('missing-target', { tabOrder: 0, executionHostId: 'local' })
    const draggedRepo = makeRepo('r-pinned', {
      executionHostId: 'local',
      projectGroupId: 'g-origin',
      projectGroupOrder: 4,
      isPinned: true
    })
    const originParent = makeGroup('g-origin', { tabOrder: 1, executionHostId: 'local' })
    const liveRepos = [{ ...draggedRepo }]
    const repoOrderCalls: {
      repoId: string
      groupId: string | null
      order: number | null
      options?: { isPinned?: boolean }
    }[] = []

    const committed = await commitProjectHeaderDragDrop({
      session: {
        repo: draggedRepo,
        groupRepo: draggedRepo,
        bucketKey: 'group:g-origin',
        sidebarRepoHeaderIds: ['r-pinned']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:missing-target',
        dropIndex: 0,
        dropIndicatorY: 42
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g-origin', ['r-pinned']],
        ['group:missing-target', []]
      ]),
      sidebarGroupChildItemIdsByGroupId: new Map([['missing-target', []]]),
      projectGroupById: new Map([
        ['g-origin', originParent],
        ['missing-target', targetParent]
      ]),
      orderedRepoIds: ['r-pinned'],
      repoById: new Map([['r-pinned', draggedRepo]]),
      liveRepos,
      getLiveRepos: () => liveRepos,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: async (targetRepo, projectGroupId, order, options) => {
        repoOrderCalls.push({ repoId: targetRepo.id, groupId: projectGroupId, order, options })
        if (projectGroupId === 'missing-target') {
          liveRepos[0] = {
            ...liveRepos[0]!,
            projectGroupId: 'missing-target',
            projectGroupOrder: order ?? undefined,
            isPinned: false
          }
          return false
        }
        liveRepos[0] = {
          ...liveRepos[0]!,
          projectGroupId,
          projectGroupOrder: order ?? undefined,
          isPinned: options?.isPinned === true
        }
        return true
      },
      onCommitProjectGroupUpdate: vi.fn(async () => true),
      onMoveToGroupHeader: vi.fn()
    })

    expect(committed).toBe(false)
    expect(repoOrderCalls).toEqual([
      { repoId: 'r-pinned', groupId: 'missing-target', order: 0, options: undefined },
      { repoId: 'r-pinned', groupId: 'g-origin', order: 4, options: { isPinned: true } }
    ])
    expect(liveRepos[0]).toMatchObject({
      projectGroupId: 'g-origin',
      projectGroupOrder: 4,
      isPinned: true
    })
  })

  it('skips externally moved sibling repo and rolls back mixed-child mutations with pin restoration when sibling rejects', async () => {
    const parent = makeGroup('g1', { tabOrder: 0, executionHostId: 'local' })
    const subSib = makeGroup('sub-sib', {
      parentGroupId: 'g1',
      tabOrder: 0,
      executionHostId: 'local'
    })
    const anchorRepo = makeRepo('r-anchor', {
      executionHostId: 'local',
      projectGroupId: 'g1',
      projectGroupOrder: 0
    })
    const movedRepo = makeRepo('r-moved', {
      executionHostId: 'local',
      projectGroupId: 'g1',
      projectGroupOrder: 0
    })
    const draggedRepo = makeRepo('r-drag', {
      executionHostId: 'local',
      projectGroupId: null,
      projectGroupOrder: 5,
      isPinned: true
    })
    const liveGroups = [parent, subSib].map((entry) => ({ ...entry }))
    const liveRepos = [draggedRepo, anchorRepo, movedRepo].map((entry) => ({ ...entry }))
    const repoOrderCalls: {
      repoId: string
      groupId: string | null
      order: number | null
      options?: { isPinned?: boolean }
    }[] = []
    const groupUpdateCalls: { groupId: string; updates: Record<string, unknown> }[] = []
    const onDropFailed = vi.fn()

    const committed = await commitProjectHeaderDragDrop({
      session: {
        repo: liveRepos[0]!,
        bucketKey: 'ungrouped',
        sidebarRepoHeaderIds: ['r-drag']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:g1',
        dropIndex: 1,
        dropIndicatorY: 56
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['r-drag']],
        ['group:g1', ['r-anchor', 'r-moved']]
      ]),
      sidebarGroupChildItemIdsByGroupId: new Map([
        ['g1', ['repo:r-anchor', 'repo:r-moved', 'group:sub-sib'] as const]
      ]),
      projectGroupById: new Map([
        ['g1', parent],
        ['sub-sib', subSib]
      ]),
      orderedRepoIds: ['r-drag', 'r-anchor', 'r-moved'],
      repoById: new Map([
        ['r-drag', draggedRepo],
        ['r-anchor', anchorRepo],
        ['r-moved', movedRepo]
      ]),
      liveRepos: [draggedRepo, anchorRepo, movedRepo],
      getLiveRepos: () => liveRepos,
      getLiveProjectGroups: () => liveGroups,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: async (targetRepo, projectGroupId, order, options) => {
        repoOrderCalls.push({ repoId: targetRepo.id, groupId: projectGroupId, order, options })
        if (targetRepo.id === 'r-drag' && projectGroupId === 'g1') {
          liveRepos[0] = {
            ...liveRepos[0]!,
            projectGroupId: 'g1',
            projectGroupOrder: order ?? undefined,
            isPinned: false
          }
          // Simulate concurrent external move of sibling repo while primary write awaits.
          liveRepos[2] = { ...liveRepos[2]!, projectGroupId: null, projectGroupOrder: 9 }
        }
        return true
      },
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        groupUpdateCalls.push({ groupId, updates })
        throw new Error('persist failed')
      },
      onDropFailed,
      onMoveToGroupHeader: vi.fn()
    })

    expect(committed).toBe(false)
    expect(repoOrderCalls).toEqual([
      { repoId: 'r-drag', groupId: 'g1', order: 1, options: undefined },
      { repoId: 'r-drag', groupId: null, order: 5, options: { isPinned: true } }
    ])
    expect(groupUpdateCalls).toEqual([{ groupId: 'sub-sib', updates: { tabOrder: 3 } }])
    expect(onDropFailed).toHaveBeenCalledTimes(1)
  })

  it('does not revert a repo moved concurrently to an unrelated group during failed primary move', async () => {
    const draggedRepo = makeRepo('r-primary', {
      executionHostId: 'local',
      projectGroupId: 'g-origin',
      projectGroupOrder: 2,
      isPinned: true
    })
    const liveRepos = [{ ...draggedRepo }]
    const repoOrderCalls: { repoId: string; groupId: string | null; order: number | null }[] = []

    const ok = await executeOrderedDropMutations({
      primaryMutation: {
        kind: 'repo',
        repo: draggedRepo,
        projectGroupId: 'g-target',
        order: 0
      },
      mutations: [{ kind: 'repo', repo: draggedRepo, projectGroupId: 'g-target', order: 0 }],
      expectedParentGroupId: 'g-target',
      ownerHostId: 'local',
      projectGroupById: new Map([
        ['g-origin', makeGroup('g-origin')],
        ['g-target', makeGroup('g-target')]
      ]),
      repoById: new Map([['r-primary', draggedRepo]]),
      getLiveRepos: () => liveRepos,
      onCommitProjectGroupUpdate: vi.fn(async () => true),
      onCommitProjectGroupOrder: async (repo, groupId, order) => {
        repoOrderCalls.push({ repoId: repo.id, groupId, order })
        liveRepos[0] = {
          ...liveRepos[0]!,
          projectGroupId: 'g-concurrent-other',
          projectGroupOrder: 99,
          isPinned: false
        }
        return false
      }
    })

    expect(ok).toBe(false)
    expect(repoOrderCalls).toEqual([{ repoId: 'r-primary', groupId: 'g-target', order: 0 }])
    expect(liveRepos[0]).toMatchObject({
      projectGroupId: 'g-concurrent-other',
      projectGroupOrder: 99
    })
  })

  it('rolls back a single-mutation cross-bucket drop that returns false after partially mutating state', async () => {
    const draggedRepo = makeRepo('r-single', {
      executionHostId: 'local',
      projectGroupId: 'g-src',
      projectGroupOrder: 3,
      isPinned: true
    })
    const liveRepos = [{ ...draggedRepo }]
    const orderCalls: {
      repoId: string
      groupId: string | null
      order: number | null
      options?: { isPinned?: boolean }
    }[] = []

    const committed = await commitProjectHeaderDragDrop({
      session: {
        repo: draggedRepo,
        groupRepo: draggedRepo,
        bucketKey: 'group:g-src',
        sidebarRepoHeaderIds: ['r-single']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'group:g-empty-dst',
        dropIndex: 0,
        dropIndicatorY: 30
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g-src', ['r-single']],
        ['group:g-empty-dst', []]
      ]),
      projectGroups: [makeGroup('g-src'), makeGroup('g-empty-dst')],
      orderedRepoIds: ['r-single'],
      repoById: new Map([['r-single', draggedRepo]]),
      liveRepos,
      getLiveRepos: () => liveRepos,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: async (repo, groupId, order, options) => {
        orderCalls.push({ repoId: repo.id, groupId, order, options })
        if (groupId === 'g-empty-dst') {
          liveRepos[0] = {
            ...liveRepos[0]!,
            projectGroupId: 'g-empty-dst',
            projectGroupOrder: order ?? undefined,
            isPinned: false
          }
          return false
        }
        liveRepos[0] = {
          ...liveRepos[0]!,
          projectGroupId: groupId,
          projectGroupOrder: order ?? undefined,
          isPinned: options?.isPinned === true
        }
        return true
      },
      onMoveToGroupHeader: vi.fn()
    })

    expect(committed).toBe(false)
    expect(orderCalls).toEqual([
      { repoId: 'r-single', groupId: 'g-empty-dst', order: 0, options: undefined },
      { repoId: 'r-single', groupId: 'g-src', order: 3, options: { isPinned: true } }
    ])
  })

  it('does not revert concurrent ungrouping at matching rank on failed primary move and instead reconciles host', async () => {
    const draggedRepo = makeRepo('r-ungrouped', {
      executionHostId: 'local',
      projectGroupId: 'g-origin',
      projectGroupOrder: 2,
      isPinned: true
    })
    const liveRepos = [{ ...draggedRepo }]
    const repoOrderCalls: { repoId: string; groupId: string | null; order: number | null }[] = []
    const onReconcileHostProjectGroups = vi.fn(async () => undefined)

    const ok = await executeOrderedDropMutations({
      primaryMutation: {
        kind: 'repo',
        repo: draggedRepo,
        projectGroupId: 'g-target',
        order: 0
      },
      mutations: [{ kind: 'repo', repo: draggedRepo, projectGroupId: 'g-target', order: 0 }],
      expectedParentGroupId: 'g-target',
      ownerHostId: 'local',
      projectGroupById: new Map([
        ['g-origin', makeGroup('g-origin')],
        ['g-target', makeGroup('g-target')]
      ]),
      repoById: new Map([['r-ungrouped', draggedRepo]]),
      getLiveRepos: () => liveRepos,
      onCommitProjectGroupUpdate: vi.fn(async () => true),
      onCommitProjectGroupOrder: async (repo, groupId, order) => {
        repoOrderCalls.push({ repoId: repo.id, groupId, order })
        liveRepos[0] = {
          ...liveRepos[0]!,
          projectGroupId: null,
          projectGroupOrder: 0,
          isPinned: false
        }
        return false
      },
      onReconcileHostProjectGroups
    })

    expect(ok).toBe(false)
    expect(repoOrderCalls).toEqual([{ repoId: 'r-ungrouped', groupId: 'g-target', order: 0 }])
    expect(liveRepos[0]).toMatchObject({ projectGroupId: null, projectGroupOrder: 0 })
    expect(onReconcileHostProjectGroups).toHaveBeenCalledWith('local')
  })

  it('skips rolling back moved group and repo when concurrently pinned after write succeeds before sibling fails', async () => {
    const movedGroup = makeGroup('g-moved', { parentGroupId: 'g-origin', tabOrder: 1 })
    const movedRepo = makeRepo('r-moved', {
      executionHostId: 'local',
      projectGroupId: 'g-target',
      projectGroupOrder: 0
    })
    const failGroup = makeGroup('g-fail', { parentGroupId: 'g-target', tabOrder: 1 })
    const targetParent = makeGroup('g-target')
    const liveGroups = [targetParent, movedGroup, failGroup].map((g) => ({ ...g }))
    const liveRepos = [{ ...movedRepo }]
    const groupCalls: { groupId: string; updates: Record<string, unknown> }[] = []
    const repoCalls: { id: string; groupId: string | null; order: number | null }[] = []
    const primaryGroup = {
      kind: 'group' as const,
      groupId: 'g-moved',
      updates: { parentGroupId: 'g-target', tabOrder: 0 }
    }

    const ok = await executeOrderedDropMutations({
      primaryMutation: primaryGroup,
      mutations: [
        primaryGroup,
        { kind: 'repo', repo: movedRepo, projectGroupId: 'g-target', order: 1 },
        { kind: 'group', groupId: 'g-fail', updates: { tabOrder: 2 } }
      ],
      expectedParentGroupId: 'g-target',
      ownerHostId: 'local',
      projectGroupById: new Map(liveGroups.map((g) => [g.id, g])),
      repoById: new Map([['r-moved', movedRepo]]),
      getLiveProjectGroups: () => liveGroups,
      getLiveRepos: () => liveRepos,
      onCommitProjectGroupOrder: async (repo, groupId, order) => {
        repoCalls.push({ id: repo.id, groupId, order })
        liveRepos[0] = {
          ...liveRepos[0]!,
          projectGroupId: groupId,
          projectGroupOrder: order ?? undefined,
          isPinned: false
        }
        return true
      },
      onCommitProjectGroupUpdate: async (groupId, updates) => {
        groupCalls.push({ groupId, updates })
        if (groupId === 'g-fail') {
          liveRepos[0] = { ...liveRepos[0]!, isPinned: true }
          liveGroups.find((g) => g.id === 'g-moved')!.isPinned = true
          return false
        }
        const target = liveGroups.find((g) => g.id === groupId)
        if (target) {
          Object.assign(target, updates)
          if (updates.parentGroupId !== undefined && updates.isPinned === undefined) {
            target.isPinned = false
          }
        }
        return true
      },
      onDropFailed: vi.fn()
    })

    expect(ok).toBe(false)
    expect(repoCalls).toEqual([{ id: 'r-moved', groupId: 'g-target', order: 1 }])
    expect(groupCalls).toEqual([
      { groupId: 'g-moved', updates: { parentGroupId: 'g-target', tabOrder: 0 } },
      { groupId: 'g-fail', updates: { tabOrder: 2 } }
    ])
    expect(liveRepos[0]).toMatchObject({ projectGroupId: 'g-target', isPinned: true })
    expect(liveGroups.find((g) => g.id === 'g-moved')).toMatchObject({
      parentGroupId: 'g-target',
      isPinned: true
    })
  })
})
