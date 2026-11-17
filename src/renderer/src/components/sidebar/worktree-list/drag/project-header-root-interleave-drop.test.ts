import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { computeCombinedProjectHeaderDropTarget } from './project-header-group-drop'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

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

describe('project header foreign-host sibling indexing & grouped root-interleaved exit', () => {
  it('counts resolvable same-host siblings before both source and drop indices when foreign headers precede the bucket', async () => {
    const foreign0 = makeRepo('f0', { executionHostId: 'ssh:other', projectGroupOrder: 0 })
    const foreign1 = makeRepo('f1', { executionHostId: 'ssh:other', projectGroupOrder: 1 })
    const dragged = makeRepo('dragged', { executionHostId: 'local', projectGroupOrder: 0 })
    const siblingA = makeRepo('sib-a', { executionHostId: 'local', projectGroupOrder: 10 })
    const siblingB = makeRepo('sib-b', { executionHostId: 'local', projectGroupOrder: 20 })
    const onCommitProjectGroupOrder = vi.fn()

    await commitProjectHeaderDragDrop({
      session: {
        repo: dragged,
        groupRepo: dragged,
        bucketKey: 'ungrouped',
        sidebarRepoHeaderIds: ['f0', 'f1', 'dragged', 'sib-a', 'sib-b']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'ungrouped',
        dropIndex: 4,
        dropIndicatorY: 90
      },
      sidebarRepoHeaderIdsByBucket: new Map([
        ['ungrouped', ['f0', 'f1', 'dragged', 'sib-a', 'sib-b']]
      ]),
      orderedRepoIds: ['f0', 'f1', 'dragged', 'sib-a', 'sib-b'],
      repoById: new Map([
        ['f0', foreign0],
        ['f1', foreign1],
        ['dragged', dragged],
        ['sib-a', siblingA],
        ['sib-b', siblingB]
      ]),
      liveRepos: [dragged, siblingA, siblingB],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(dragged, null, 15)
  })

  it('routes grouped projects dropped beside root groups through root-interleaved placement and awaits respace rollback', async () => {
    const gRoot = makeGroup('g-root', { tabOrder: 0, rootProjectOrder: 0 })
    const rootProject = makeRepo('r-root', { projectGroupOrder: 10 })
    const groupedProject = makeRepo('r-grouped', {
      projectGroupId: 'g-root',
      projectGroupOrder: 5
    })
    const groupHeaderRects = [
      {
        groupId: 'g-root',
        bucketKey: 'root',
        headerIndex: 0,
        top: 28,
        bottom: 56,
        sectionBottom: 112
      }
    ]
    const rootHeaderRects = [
      {
        repoId: 'group:g-root',
        bucketKey: 'root-interleaved',
        headerIndex: 0,
        top: 28,
        bottom: 56
      },
      {
        repoId: 'repo:r-root',
        bucketKey: 'root-interleaved',
        headerIndex: 1,
        top: 120,
        bottom: 148
      }
    ]

    const targetAboveRootGroup = computeCombinedProjectHeaderDropTarget({
      pointerY: 10,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g-root',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-root']),
      groupHeaderRects,
      repoHeaderRects: [
        { repoId: 'r-grouped', bucketKey: 'group:g-root', headerIndex: 0, top: 60, bottom: 88 }
      ],
      rootProjectHeaderKeys: ['group:g-root', 'repo:r-root'],
      rootHeaderRects,
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g-root', ['r-grouped']],
        ['ungrouped', ['r-root']]
      ]),
      contentBottom: 148
    })
    expect(targetAboveRootGroup).toEqual({
      kind: 'slot',
      targetBucketKey: 'root-interleaved',
      dropIndex: 0,
      dropIndicatorY: 25
    })

    const calls: { id: string; groupId: string | null; order: number | null }[] = []
    const committed = await commitProjectHeaderDragDrop({
      session: {
        repo: groupedProject,
        groupRepo: groupedProject,
        bucketKey: 'group:g-root',
        sidebarRepoHeaderIds: ['r-grouped'],
        rootProjectHeaderKeys: ['group:g-root', 'repo:r-root']
      },
      dropTarget: targetAboveRootGroup!,
      sidebarRepoHeaderIdsByBucket: new Map([['group:g-root', ['r-grouped']]]),
      orderedRepoIds: ['r-grouped', 'r-root'],
      repoById: new Map([
        ['r-grouped', groupedProject],
        ['r-root', rootProject]
      ]),
      liveRepos: [groupedProject, rootProject],
      projectGroups: [gRoot],
      projectGroupById: new Map([['g-root', gRoot]]),
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder: async (repo, groupId, order) => {
        calls.push({ id: repo.id, groupId, order })
        return true
      },
      onMoveToGroupHeader: vi.fn()
    })

    expect(committed).toBe(true)
    expect(calls).toEqual([{ id: 'r-grouped', groupId: null, order: -1000 }])

    // Respace rollback restores previous group when still in post-move state, and skips if concurrently moved.
    const rPinnedSrc = makeRepo('r-src', { projectGroupId: 'g-root', projectGroupOrder: 3 })
    const rEpsA = makeRepo('r-eps-a', { projectGroupOrder: 1 })
    const rEpsB = makeRepo('r-eps-b', { projectGroupOrder: 1 + Number.EPSILON })
    const liveRepos = [rPinnedSrc, rEpsA, rEpsB]
    const rollbackCalls: { id: string; groupId: string | null; order: number | null }[] = []
    let concurrentMove = false
    const runFailingRespace = () =>
      commitProjectHeaderDragDrop({
        session: {
          repo: rPinnedSrc,
          groupRepo: rPinnedSrc,
          bucketKey: 'group:g-root',
          sidebarRepoHeaderIds: ['r-src'],
          rootProjectHeaderKeys: ['repo:r-eps-a', 'repo:r-eps-b']
        },
        dropTarget: {
          kind: 'slot',
          targetBucketKey: 'root-interleaved',
          dropIndex: 1,
          dropIndicatorY: 40
        },
        sidebarRepoHeaderIdsByBucket: new Map([['group:g-root', ['r-src']]]),
        orderedRepoIds: ['r-src', 'r-eps-a', 'r-eps-b'],
        repoById: new Map(liveRepos.map((r) => [r.id, r])),
        liveRepos,
        getLiveRepos: () => liveRepos,
        projectGroups: [gRoot],
        projectGroupById: new Map([['g-root', gRoot]]),
        usesProjectGroupOrdering: true,
        onCommitRepoOrder: vi.fn(),
        onCommitProjectGroupOrder: async (repo, groupId, order) => {
          rollbackCalls.push({ id: repo.id, groupId, order })
          repo.projectGroupId = groupId
          repo.projectGroupOrder = order ?? undefined
          return true
        },
        onCommitRootProjectOrder: async () => {
          if (concurrentMove) {
            liveRepos[0] = { ...liveRepos[0]!, projectGroupId: 'other-group', projectGroupOrder: 9 }
          }
          return false
        },
        onMoveToGroupHeader: vi.fn()
      })

    expect(await runFailingRespace()).toBe(false)
    expect(rollbackCalls).toEqual([
      { id: 'r-src', groupId: null, order: 1 },
      { id: 'r-src', groupId: 'g-root', order: 3 }
    ])

    rollbackCalls.length = 0
    concurrentMove = true
    liveRepos[0] = makeRepo('r-src', { projectGroupId: 'g-root', projectGroupOrder: 3 })
    expect(await runFailingRespace()).toBe(false)
    expect(rollbackCalls).toEqual([{ id: 'r-src', groupId: null, order: 1 }])
  })

  it('counts resolved destination siblings before drop slot on cross-bucket drops when foreign headers precede', async () => {
    const foreign0 = makeRepo('f0', {
      executionHostId: 'runtime:env-other',
      projectGroupOrder: 999
    })
    const dragged = makeRepo('dragged', {
      executionHostId: 'local',
      projectGroupId: 'g-src',
      projectGroupOrder: 0
    })
    const siblingA = makeRepo('sib-a', { executionHostId: 'local', projectGroupOrder: 0 })
    const siblingB = makeRepo('sib-b', { executionHostId: 'local', projectGroupOrder: 10 })
    const onCommitProjectGroupOrder = vi.fn()
    const repoById = new Map([
      ['f0', foreign0],
      ['dragged', dragged],
      ['sib-a', siblingA],
      ['sib-b', siblingB]
    ])
    const liveRepos = [foreign0, dragged, siblingA, siblingB]
    const sidebarRepoHeaderIdsByBucket = new Map([
      ['group:g-src', ['dragged']],
      ['ungrouped', ['f0', 'sib-a', 'sib-b']]
    ])
    const gSrc = makeGroup('g-src', { tabOrder: 0 })
    const target = computeCombinedProjectHeaderDropTarget({
      pointerY: 186,
      containerTop: 0,
      scrollTop: 0,
      dragHostId: 'local',
      currentGroupId: 'g-src',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-src']),
      hostHeaderRects: [
        { hostId: 'runtime:env-other', top: 0, bottom: 20 },
        { hostId: 'local', top: 50, bottom: 70 }
      ],
      groupHeaderRects: [
        {
          groupId: 'g-src',
          bucketKey: 'root',
          headerIndex: 0,
          top: 70,
          bottom: 98,
          sectionBottom: 130
        }
      ],
      repoHeaderRects: [
        { repoId: 'f0', bucketKey: 'ungrouped', headerIndex: 0, top: 20, bottom: 48 },
        { repoId: 'dragged', bucketKey: 'group:g-src', headerIndex: 0, top: 98, bottom: 126 },
        { repoId: 'sib-a', bucketKey: 'ungrouped', headerIndex: 1, top: 140, bottom: 168 },
        { repoId: 'sib-b', bucketKey: 'ungrouped', headerIndex: 2, top: 176, bottom: 204 }
      ],
      sidebarRepoHeaderIdsByBucket,
      repoById,
      liveRepos
    })
    expect(target).not.toBeNull()

    await commitProjectHeaderDragDrop({
      session: {
        repo: dragged,
        groupRepo: dragged,
        bucketKey: 'group:g-src',
        sidebarRepoHeaderIds: ['dragged']
      },
      dropTarget: target!,
      sidebarRepoHeaderIdsByBucket,
      orderedRepoIds: ['f0', 'dragged', 'sib-a', 'sib-b'],
      repoById,
      liveRepos,
      projectGroups: [gSrc],
      projectGroupById: new Map([['g-src', gSrc]]),
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(dragged, null, 5)
  })

  it('prefers exact execution-host twin registrations over later foreign twins in interleaved root ordering', async () => {
    const dragged = makeRepo('r-exit', {
      executionHostId: 'local',
      projectGroupId: 'g-src',
      projectGroupOrder: 5
    })
    const localN1 = makeRepo('n1', { executionHostId: 'local', projectGroupOrder: 0 })
    const localN2 = makeRepo('n2', { executionHostId: 'local', projectGroupOrder: 10 })
    const sshN1 = makeRepo('n1', { executionHostId: 'ssh:remote', projectGroupOrder: 100 })
    const sshN2 = makeRepo('n2', { executionHostId: 'ssh:remote', projectGroupOrder: 110 })
    const onCommitProjectGroupOrder = vi.fn(async () => true)

    await commitProjectHeaderDragDrop({
      session: {
        repo: dragged,
        groupRepo: dragged,
        bucketKey: 'group:g-src',
        sidebarRepoHeaderIds: ['r-exit'],
        rootProjectHeaderKeys: ['repo:n1', 'repo:n2']
      },
      dropTarget: {
        kind: 'slot',
        targetBucketKey: 'root-interleaved',
        dropIndex: 1,
        dropIndicatorY: 40
      },
      sidebarRepoHeaderIdsByBucket: new Map([['group:g-src', ['r-exit']]]),
      orderedRepoIds: ['r-exit', 'n1', 'n2'],
      repoById: new Map([
        ['r-exit', dragged],
        ['n1', sshN1],
        ['n2', sshN2]
      ]),
      liveRepos: [dragged, localN1, localN2, sshN1, sshN2],
      projectGroups: [makeGroup('g-src')],
      projectGroupById: new Map([['g-src', makeGroup('g-src')]]),
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onMoveToGroupHeader: vi.fn()
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(dragged, null, 5)
  })
})
