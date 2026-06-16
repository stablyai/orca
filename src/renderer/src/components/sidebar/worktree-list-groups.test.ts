/* eslint-disable max-lines -- Why: row-builder tests keep grouping, pinning, and lineage ordering cases together so expected row contracts stay comparable. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import {
  ALL_GROUP_META,
  buildRows,
  getGroupKeyForWorktree,
  getGroupKeysForWorktree,
  getLineageGroupKey,
  getLineageRenderInfo,
  getPRGroupKey,
  type PendingCreationRef
} from './worktree-list-groups'
import type {
  DetectedWorktree,
  Project,
  ProjectHostSetup,
  FolderWorkspace,
  Repo,
  ProjectGroup,
  Worktree,
  WorktreeLineage
} from '../../../../shared/types'

const localHostLabel = getLocalExecutionHostLabel()

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/orca',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: 0
}

const worktree: Worktree = {
  id: 'wt-1',
  repoId: repo.id,
  path: '/tmp/orca-feature',
  branch: 'refs/heads/feature/super-critical',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
  displayName: 'feature/super-critical',
  sortOrder: 0,
  lastActivityAt: 0
}

const repoMap = new Map([[repo.id, repo]])

const remoteRepo: Repo = {
  id: 'repo-remote',
  path: '/home/alice/orca',
  displayName: 'orca',
  badgeColor: '#111111',
  addedAt: 1,
  connectionId: 'gpu-vm'
}

const remoteWorktree: Worktree = {
  ...worktree,
  id: 'wt-remote',
  repoId: remoteRepo.id,
  path: '/home/alice/orca-feature',
  displayName: 'remote feature'
}

const project: Project = {
  id: 'github:stablyai/orca',
  displayName: 'Orca',
  badgeColor: '#737373',
  sourceRepoIds: [repo.id, remoteRepo.id],
  createdAt: 1,
  updatedAt: 1
}

const projectHostSetups: ProjectHostSetup[] = [
  {
    id: repo.id,
    projectId: project.id,
    hostId: 'local',
    repoId: repo.id,
    path: repo.path,
    displayName: repo.displayName,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  },
  {
    id: remoteRepo.id,
    projectId: project.id,
    hostId: 'ssh:gpu-vm',
    repoId: remoteRepo.id,
    path: remoteRepo.path,
    displayName: remoteRepo.displayName,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
]

function makeDetectedWorktree(overrides: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    ...worktree,
    id: overrides.id ?? `${repo.id}::/tmp/${overrides.displayName ?? 'hidden'}`,
    path: overrides.path ?? `/tmp/${overrides.displayName ?? 'hidden'}`,
    displayName: overrides.displayName ?? 'hidden',
    visible: false,
    selectedCheckout: false,
    ownership: 'external',
    ...overrides
  }
}

describe('getPRGroupKey', () => {
  it('puts merged PRs in the done group', () => {
    const prCache = {
      'repo-1::feature/super-critical': {
        data: { state: 'merged' }
      }
    }

    expect(getPRGroupKey(worktree, repoMap, prCache)).toBe('done')
  })

  it('prefers repo-scoped PR status over stale legacy path-scoped status', () => {
    const prCache = {
      '/tmp/orca::feature/super-critical': {
        data: { state: 'closed' }
      },
      'repo-1::feature/super-critical': {
        data: { state: 'merged' }
      }
    }

    expect(getPRGroupKey(worktree, repoMap, prCache)).toBe('done')
  })

  it('falls back to legacy path-scoped PR status when no repo-scoped entry exists', () => {
    const prCache = {
      '/tmp/orca::feature/super-critical': {
        data: { state: 'closed' }
      }
    }

    expect(getPRGroupKey(worktree, repoMap, prCache)).toBe('closed')
  })

  it('does not fall back to local PR cache while runtime scoped data is loading', () => {
    const prCache = {
      'repo-1::feature/super-critical': {
        data: { state: 'merged' }
      }
    }

    expect(
      getPRGroupKey(worktree, repoMap, prCache, {
        activeRuntimeEnvironmentId: 'env-1'
      } as never)
    ).toBe('in-progress')
  })

  it('uses SSH-scoped PR cache entries instead of local entries for SSH repos', () => {
    const sshRepo = { ...repo, connectionId: 'ssh-1' }
    const sshRepoMap = new Map([[sshRepo.id, sshRepo]])
    const prCache = {
      'repo-1::feature/super-critical': {
        data: { state: 'merged' }
      },
      'ssh:ssh-1::repo-1::feature/super-critical': {
        data: { state: 'closed' }
      }
    }

    expect(getPRGroupKey(worktree, sshRepoMap, prCache)).toBe('closed')
  })
})

describe('getGroupKeyForWorktree', () => {
  it('returns the all group key for the ungrouped mode', () => {
    expect(getGroupKeyForWorktree('none', worktree, repoMap, null)).toBe('all')
  })

  it('returns a workspace-status key only in status grouping mode', () => {
    expect(getGroupKeyForWorktree('workspace-status', worktree, repoMap, null)).toBe(
      'workspace-status:in-progress'
    )
  })
})

describe('buildRows with pinned worktrees', () => {
  const pinned = { ...worktree, id: 'wt-pinned', isPinned: true, displayName: 'pinned-feature' }
  const unpinned1 = { ...worktree, id: 'wt-1', displayName: 'alpha' }
  const unpinned2 = { ...worktree, id: 'wt-2', displayName: 'beta' }

  it('emits Pinned and All headers in groupBy none', () => {
    const rows = buildRows('none', [unpinned1, pinned, unpinned2], repoMap, null, new Set())
    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned', label: 'Pinned', count: 1 })
    expect(rows[1]).toMatchObject({ type: 'item', worktree: { id: 'wt-pinned' } })
    expect(rows[2]).toMatchObject({ type: 'header', key: 'all', label: 'All', count: 3 })
    expect(rows[2]).toMatchObject({ type: 'header', icon: ALL_GROUP_META.icon })
  })

  it('groups all worktrees under All in groupBy none', () => {
    const rows = buildRows('none', [unpinned1, unpinned2], repoMap, null, new Set())

    expect(rows).toMatchObject([
      { type: 'header', key: 'all', label: 'All', count: 2 },
      { type: 'item', worktree: { id: 'wt-1' } },
      { type: 'item', worktree: { id: 'wt-2' } }
    ])
  })

  it('keeps pinned worktrees above the All group', () => {
    const rows = buildRows('none', [unpinned1, pinned, unpinned2], repoMap, null, new Set())

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned', count: 1 },
      { type: 'item', worktree: { id: 'wt-pinned' } },
      { type: 'header', key: 'all', count: 3 },
      { type: 'item', worktree: { id: 'wt-1' } },
      { type: 'item', worktree: { id: 'wt-pinned' } },
      { type: 'item', worktree: { id: 'wt-2' } }
    ])
  })

  it('collapses the All group in groupBy none', () => {
    const rows = buildRows('none', [unpinned1, pinned, unpinned2], repoMap, null, new Set(['all']))

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned', count: 1 },
      { type: 'item', worktree: { id: 'wt-pinned' } },
      { type: 'header', key: 'all', count: 3 }
    ])
  })

  it('emits status headers for all matching worktrees in groupBy workspace-status', () => {
    const rows = buildRows(
      'workspace-status',
      [unpinned1, pinned, unpinned2],
      repoMap,
      null,
      new Set()
    )
    expect(rows[2]).toMatchObject({
      type: 'header',
      key: 'workspace-status:in-progress',
      label: 'In progress',
      count: 3
    })
    expect(rows[3]).toMatchObject({ type: 'item', worktree: { id: 'wt-1' } })
    expect(rows[4]).toMatchObject({ type: 'item', worktree: { id: 'wt-pinned' } })
    expect(rows[5]).toMatchObject({ type: 'item', worktree: { id: 'wt-2' } })
  })

  it('keeps pinned items in regular groups in pr-status mode', () => {
    const rows = buildRows('pr-status', [unpinned1, pinned], repoMap, null, new Set())
    const pinnedHeader = rows.find((r) => r.type === 'header' && r.key === 'pinned')
    expect(pinnedHeader).toBeDefined()
    const prGroup = rows.filter((r) => r.type === 'header' && r.key.startsWith('pr:'))
    for (const header of prGroup) {
      if (header.type === 'header') {
        expect(header.count).toBe(2)
      }
    }
  })

  it('omits empty pinned sections in groupBy workspace-status', () => {
    const rows = buildRows('workspace-status', [unpinned1, unpinned2], repoMap, null, new Set())
    expect(rows[0]).toMatchObject({
      type: 'header',
      key: 'workspace-status:in-progress',
      label: 'In progress',
      count: 2
    })
    expect(rows[1]).toMatchObject({ type: 'item', worktree: { id: 'wt-1' } })
    expect(rows[2]).toMatchObject({ type: 'item', worktree: { id: 'wt-2' } })
  })

  it('collapses pinned group when in collapsedGroups', () => {
    const rows = buildRows(
      'workspace-status',
      [pinned, unpinned1],
      repoMap,
      null,
      new Set(['pinned'])
    )
    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned' })
    expect(rows[1]).toMatchObject({ type: 'header', key: 'workspace-status:in-progress' })
    expect(rows[2]).toMatchObject({ type: 'item', worktree: { id: 'wt-pinned' } })
    expect(rows[3]).toMatchObject({ type: 'item', worktree: { id: 'wt-1' } })
  })

  it('keeps status sections complete when all worktrees are pinned', () => {
    const allPinned = { ...unpinned1, isPinned: true }
    const rows = buildRows('workspace-status', [pinned, allPinned], repoMap, null, new Set())
    expect(rows.filter((r) => r.type === 'header')).toHaveLength(2)
    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned', count: 2 })
    expect(rows[3]).toMatchObject({
      type: 'header',
      key: 'workspace-status:in-progress',
      count: 2
    })
  })

  it('preserves repo display casing in group labels', () => {
    const lowercaseRepo = { ...repo, displayName: 'c15t' }
    const rows = buildRows('repo', [worktree], new Map([[repo.id, lowercaseRepo]]), null, new Set())

    expect(rows[0]).toMatchObject({ type: 'header', label: 'c15t' })
  })

  it('groups multiple host setups for the same project under one project header', () => {
    const rows = buildRows(
      'repo',
      [worktree, remoteWorktree],
      new Map([
        [repo.id, repo],
        [remoteRepo.id, remoteRepo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [worktree.id, worktree],
        [remoteWorktree.id, remoteWorktree]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      [],
      { projects: [project], projectHostSetups }
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'project:github:stablyai/orca', label: 'Orca', count: 2 },
      { type: 'item', worktree: { id: worktree.id }, hostContextLabel: localHostLabel },
      { type: 'item', worktree: { id: remoteWorktree.id }, hostContextLabel: 'gpu-vm' }
    ])
  })

  it('splits same-host checkouts of one project into separate per-setup groups', () => {
    // Why: multiple local clones/worktrees of one repo share the GitHub slug, so
    // collapsing to the project would merge them into one arbitrarily-named group.
    // They are distinct ProjectHostSetups on the same host and must stay separate.
    const repoB: Repo = { ...repo, id: 'repo-2', path: '/tmp/orca-2', displayName: 'orca-2' }
    const worktreeB: Worktree = {
      ...worktree,
      id: 'wt-2',
      repoId: repoB.id,
      path: '/tmp/orca-2-feature',
      displayName: 'feature-b'
    }
    const localSetupB: ProjectHostSetup = {
      ...projectHostSetups[0]!,
      id: repoB.id,
      repoId: repoB.id,
      path: repoB.path,
      displayName: repoB.displayName
    }
    const rows = buildRows(
      'repo',
      [worktree, worktreeB],
      new Map([
        [repo.id, repo],
        [repoB.id, repoB]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [worktree.id, worktree],
        [worktreeB.id, worktreeB]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      [],
      {
        projects: [{ ...project, sourceRepoIds: [repo.id, repoB.id] }],
        projectHostSetups: [projectHostSetups[0]!, localSetupB]
      }
    )

    const headers = rows.filter((row) => row.type === 'header')
    expect(headers).toHaveLength(2)
    expect(headers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'project:github:stablyai/orca::setup:repo-1',
          label: 'orca'
        }),
        expect.objectContaining({
          key: 'project:github:stablyai/orca::setup:repo-2',
          label: 'orca-2'
        })
      ])
    )
  })

  it('uses saved host labels for mixed-host sidebar card badges', () => {
    const runtimeRepo: Repo = {
      ...remoteRepo,
      id: 'repo-runtime',
      path: '/Users/alice/runtime-orca',
      connectionId: null,
      executionHostId: 'runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3'
    }
    const runtimeWorktree: Worktree = {
      ...remoteWorktree,
      id: 'wt-runtime',
      repoId: runtimeRepo.id
    }
    const runtimeSetup: ProjectHostSetup = {
      ...projectHostSetups[1]!,
      id: runtimeRepo.id,
      hostId: 'runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3',
      repoId: runtimeRepo.id,
      path: runtimeRepo.path
    }
    const rows = buildRows(
      'repo',
      [worktree, runtimeWorktree],
      new Map([
        [repo.id, repo],
        [runtimeRepo.id, runtimeRepo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [worktree.id, worktree],
        [runtimeWorktree.id, runtimeWorktree]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      [],
      { projects: [project], projectHostSetups: [projectHostSetups[0]!, runtimeSetup] },
      [],
      new Map([
        ['local', localHostLabel],
        ['runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3', 'dev box']
      ])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'project:github:stablyai/orca', label: 'Orca', count: 2 },
      { type: 'item', worktree: { id: worktree.id }, hostContextLabel: localHostLabel },
      { type: 'item', worktree: { id: runtimeWorktree.id }, hostContextLabel: 'dev box' }
    ])
  })

  it('omits host context labels when a project group only has one host', () => {
    const secondLocalWorktree: Worktree = {
      ...worktree,
      id: 'wt-local-2',
      displayName: 'local-only'
    }
    const rows = buildRows(
      'repo',
      [worktree, secondLocalWorktree],
      new Map([[repo.id, repo]]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [worktree.id, worktree],
        [secondLocalWorktree.id, secondLocalWorktree]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      [],
      {
        projects: [{ ...project, sourceRepoIds: [repo.id] }],
        projectHostSetups: [projectHostSetups[0]]
      }
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'project:github:stablyai/orca', label: 'Orca', count: 2 },
      { type: 'item', worktree: { id: worktree.id } },
      { type: 'item', worktree: { id: secondLocalWorktree.id } }
    ])
    for (const row of rows) {
      if (row.type === 'item') {
        expect(row.hostContextLabel).toBeUndefined()
      }
    }
  })

  it('keeps same-named repos separate without project setup identity', () => {
    const rows = buildRows(
      'repo',
      [worktree, remoteWorktree],
      new Map([
        [repo.id, { ...repo, displayName: 'orca' }],
        [remoteRepo.id, { ...remoteRepo, displayName: 'orca' }]
      ]),
      null,
      new Set()
    )

    expect(rows.filter((row) => row.type === 'header')).toMatchObject([
      { key: 'repo:repo-1' },
      { key: 'repo:repo-remote' }
    ])
  })

  it('returns project group keys for worktree reveal when project setup identity exists', () => {
    expect(
      getGroupKeyForWorktree(
        'repo',
        remoteWorktree,
        new Map([[remoteRepo.id, remoteRepo]]),
        null,
        undefined,
        undefined,
        {
          projects: [project],
          projectHostSetups
        }
      )
    ).toBe('project:github:stablyai/orca')
  })

  it('emits an imported worktrees card at the top of repo-group rows', () => {
    const hidden = [
      makeDetectedWorktree({ id: 'hidden-1', displayName: 'payments-refactor' }),
      makeDetectedWorktree({ id: 'hidden-2', displayName: 'auth-cache-debug' }),
      makeDetectedWorktree({ id: 'hidden-3', displayName: 'legacy-oauth-fix' })
    ]
    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: hidden }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1' },
      {
        type: 'imported-worktrees-card',
        key: 'imported-worktrees-card:repo-group:repo-1',
        placement: 'repo-group',
        repo: { id: 'repo-1' },
        hiddenWorktrees: [{ id: 'hidden-1' }, { id: 'hidden-2' }, { id: 'hidden-3' }]
      },
      { type: 'item', worktree: { id: 'wt-1' } }
    ])
  })

  it('suppresses the repo-group imported worktrees card when the repo group is collapsed', () => {
    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(['repo:repo-1']),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([{ type: 'header', key: 'repo:repo-1' }])
  })

  it('emits a repo header and imported worktrees card when no visible worktree rows remain', () => {
    const rows = buildRows(
      'repo',
      [],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1', count: 0 },
      {
        type: 'imported-worktrees-card',
        key: 'imported-worktrees-card:repo-group:repo-1',
        placement: 'repo-group'
      }
    ])
  })

  it('emits an empty ungrouped repo placeholder before imported cards are merged', () => {
    const rows = buildRows(
      'repo',
      [],
      repoMap,
      null,
      new Set(),
      new Map([[repo.id, 0]]),
      undefined,
      'manual',
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set([repo.id]),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1', label: 'orca', count: 0 },
      {
        type: 'imported-worktrees-card',
        key: 'imported-worktrees-card:repo-group:repo-1',
        placement: 'repo-group'
      }
    ])
  })

  it('skips stale empty placeholder repo ids that are absent from repoMap', () => {
    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set([repo.id])
    )

    expect(rows).toEqual([])
  })

  it('does not emit unpinned imported worktree cards outside repo grouping', () => {
    const rows = buildRows(
      'workspace-status',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows.some((row) => row.type === 'imported-worktrees-card')).toBe(false)
  })

  it('emits imported worktree cards in repo groups when visible rows are pinned', () => {
    const repoTwo: Repo = { ...repo, id: 'repo-2', displayName: 'auth-service' }
    const pinnedOneA = { ...worktree, id: 'repo-1-pinned-a', isPinned: true }
    const pinnedTwo = {
      ...worktree,
      id: 'repo-2-pinned',
      repoId: repoTwo.id,
      isPinned: true,
      displayName: 'auth-main'
    }
    const pinnedOneB = { ...worktree, id: 'repo-1-pinned-b', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedOneA, pinnedTwo, pinnedOneB],
      new Map([
        [repo.id, repo],
        [repoTwo.id, repoTwo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [pinnedOneA.id, pinnedOneA],
        [pinnedTwo.id, pinnedTwo],
        [pinnedOneB.id, pinnedOneB]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map([
        [repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree({ id: 'hidden-one' })] }],
        [
          repoTwo.id,
          {
            repo: repoTwo,
            hiddenWorktrees: [makeDetectedWorktree({ id: 'hidden-two', repoId: repoTwo.id })]
          }
        ]
      ])
    )

    expect(rows.filter((row) => row.type === 'imported-worktrees-card')).toMatchObject([
      {
        key: 'imported-worktrees-card:repo-group:repo-1',
        placement: 'repo-group'
      },
      {
        key: 'imported-worktrees-card:repo-group:repo-2',
        placement: 'repo-group'
      }
    ])
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'item',
          worktree: expect.objectContaining({ id: 'repo-1-pinned-a' })
        }),
        expect.objectContaining({
          type: 'item',
          worktree: expect.objectContaining({ id: 'repo-1-pinned-b' })
        }),
        expect.objectContaining({
          type: 'item',
          worktree: expect.objectContaining({ id: 'repo-2-pinned' })
        })
      ])
    )
  })

  it('suppresses pinned imported worktree fallback when the repo has visible unpinned rows', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree, worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [pinnedWorktree.id, pinnedWorktree],
        [worktree.id, worktree]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows.filter((row) => row.type === 'imported-worktrees-card')).toMatchObject([
      { placement: 'repo-group' }
    ])
  })

  it('keeps repo imported worktree cards visible when Pinned is collapsed', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(['pinned']),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned' },
      { type: 'header', key: 'repo:repo-1' },
      { type: 'imported-worktrees-card', placement: 'repo-group' },
      { type: 'item', worktree: { id: 'wt-pinned' } }
    ])
  })

  it('groups folder-mode workspaces under their folder name', () => {
    const folderRepo: Repo = {
      ...repo,
      id: 'folder-1',
      path: '/tmp/design-assets',
      displayName: 'design-assets',
      kind: 'folder'
    }
    const folderWorktree: Worktree = {
      ...worktree,
      id: 'folder-1::/tmp/design-assets',
      repoId: folderRepo.id,
      path: folderRepo.path,
      branch: '',
      displayName: folderRepo.displayName,
      isMainWorktree: true
    }
    const rows = buildRows(
      'repo',
      [folderWorktree],
      new Map([[folderRepo.id, folderRepo]]),
      null,
      new Set()
    )

    expect(rows[0]).toMatchObject({
      type: 'header',
      key: 'repo:folder-1',
      label: 'design-assets',
      count: 1,
      repo: folderRepo
    })
    expect(rows[1]).toMatchObject({ type: 'item', worktree: { id: folderWorktree.id } })
  })

  it('emits assigned workspace statuses as sections in groupBy workspace-status', () => {
    const review = { ...worktree, id: 'wt-review', workspaceStatus: 'in-review' as const }
    const rows = buildRows('workspace-status', [review], repoMap, null, new Set())

    expect(
      rows
        .filter((r) => r.type === 'header')
        .map((r) => ({ key: r.key, label: r.label, count: r.count }))
    ).toEqual([{ key: 'workspace-status:in-review', label: 'In review', count: 1 }])
  })

  it('uses customized workspace status labels and order', () => {
    const customStatuses = [
      { id: 'blocked', label: 'Blocked' },
      { id: 'todo', label: 'Ready' },
      { id: 'in-progress', label: 'Doing' }
    ]
    const blocked = { ...worktree, id: 'wt-blocked', workspaceStatus: 'blocked' }
    const doing = { ...worktree, id: 'wt-doing', workspaceStatus: 'in-progress' }
    const rows = buildRows(
      'workspace-status',
      [doing, blocked],
      repoMap,
      null,
      new Set(),
      undefined,
      customStatuses
    )

    expect(
      rows
        .filter((r) => r.type === 'header')
        .map((r) => ({ key: r.key, label: r.label, count: r.count }))
    ).toEqual([
      { key: 'workspace-status:blocked', label: 'Blocked', count: 1 },
      { key: 'workspace-status:in-progress', label: 'Doing', count: 1 }
    ])
  })
})

describe('buildRows project grouping order', () => {
  const repoA: Repo = { ...repo, id: 'repo-a', displayName: 'alpha' }
  const repoB: Repo = { ...repo, id: 'repo-b', displayName: 'beta' }
  const repoC: Repo = { ...repo, id: 'repo-c', displayName: 'gamma' }
  const map = new Map([
    [repoA.id, repoA],
    [repoB.id, repoB],
    [repoC.id, repoC]
  ])
  // Activity: C (300) is freshest, then A (200), then B (100). wAStale (50) is
  // an older sibling of A so a repo's rank is its max child, not its first.
  const wA: Worktree = {
    ...worktree,
    id: 'wt-a',
    repoId: repoA.id,
    displayName: 'a',
    lastActivityAt: 200
  }
  const wAStale: Worktree = {
    ...worktree,
    id: 'wt-a-stale',
    repoId: repoA.id,
    displayName: 'a2',
    lastActivityAt: 50
  }
  const wB: Worktree = {
    ...worktree,
    id: 'wt-b',
    repoId: repoB.id,
    displayName: 'b',
    lastActivityAt: 100
  }
  const wC: Worktree = {
    ...worktree,
    id: 'wt-c',
    repoId: repoC.id,
    displayName: 'c',
    lastActivityAt: 300
  }

  it('orders repo headers by explicit repoOrder, not first-encounter', () => {
    // Worktree stream encounters in order C, A, B — but repoOrder says B, A, C.
    const repoOrder = new Map([
      [repoB.id, 0],
      [repoA.id, 1],
      [repoC.id, 2]
    ])
    const rows = buildRows('repo', [wC, wA, wB], map, null, new Set(), repoOrder)
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-b', 'repo:repo-a', 'repo:repo-c'])
  })

  it('places unknown repo ids last and sorts them by label', () => {
    // Only repoB is in repoOrder; repoA and repoC fall through to label sort.
    const repoOrder = new Map([[repoB.id, 0]])
    const rows = buildRows('repo', [wC, wA, wB], map, null, new Set(), repoOrder)
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-b', 'repo:repo-a', 'repo:repo-c'])
  })

  it('orders repo headers by max(lastActivityAt) per repo in Recent mode', () => {
    // repoOrder pins B, A, C, but Recent ignores it: C (300) > A (200) > B (100).
    // The incoming array is name-sorted (not pre-sorted by recency), proving the
    // resolver computes the timestamp itself rather than trusting encounter order.
    const repoOrder = new Map([
      [repoB.id, 0],
      [repoA.id, 1],
      [repoC.id, 2]
    ])
    const rows = buildRows(
      'repo',
      [wA, wB, wC],
      map,
      null,
      new Set(),
      repoOrder,
      undefined,
      'recent'
    )
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-c', 'repo:repo-a', 'repo:repo-b'])
  })

  it("uses each repo's freshest visible child, not its first, in Recent mode", () => {
    // repo-a has a fresh child (200) and a stale one (50); its rank is the max.
    const rows = buildRows(
      'repo',
      [wAStale, wA, wB, wC],
      map,
      null,
      new Set(),
      undefined,
      undefined,
      'recent'
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-c' },
      { type: 'item', worktree: { id: 'wt-c' } },
      { type: 'header', key: 'repo:repo-a' },
      // Child rows keep their input order; only the header rank uses max activity.
      { type: 'item', worktree: { id: 'wt-a-stale' } },
      { type: 'item', worktree: { id: 'wt-a' } },
      { type: 'header', key: 'repo:repo-b' },
      { type: 'item', worktree: { id: 'wt-b' } }
    ])
  })

  it('keeps the main workspace first inside its project group in Recent mode', () => {
    const main = {
      ...wA,
      id: 'wt-a-main',
      displayName: 'main',
      isMainWorktree: true,
      lastActivityAt: 10
    }
    const freshChild = {
      ...wA,
      id: 'wt-a-fresh-child',
      displayName: 'fresh-child',
      isMainWorktree: false,
      lastActivityAt: 500
    }
    const rows = buildRows(
      'repo',
      [freshChild, wB, main],
      map,
      null,
      new Set(),
      undefined,
      undefined,
      'recent'
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-a' },
      { type: 'item', worktree: { id: 'wt-a-main' } },
      { type: 'item', worktree: { id: 'wt-a-fresh-child' } },
      { type: 'header', key: 'repo:repo-b' },
      { type: 'item', worktree: { id: 'wt-b' } }
    ])
  })

  it('orders repo headers by repoOrder in Manual mode (default), ignoring activity', () => {
    const repoOrder = new Map([
      [repoB.id, 0],
      [repoA.id, 1],
      [repoC.id, 2]
    ])
    const rows = buildRows('repo', [wC, wA, wB], map, null, new Set(), repoOrder)
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-b', 'repo:repo-a', 'repo:repo-c'])
  })

  it('builds rows for a very large repo-group list', () => {
    const count = 130_000
    const repos = new Map<string, Repo>()
    const worktrees = Array.from({ length: count }, (_, index) => {
      const repoId = `repo-${index}`
      repos.set(repoId, { ...repo, id: repoId, displayName: `repo ${index}` })
      return { ...worktree, id: `wt-${index}`, repoId, displayName: `workspace ${index}` }
    })

    const rows = buildRows('repo', worktrees, repos, null, new Set())

    expect(rows).toHaveLength(count * 2)
    expect(rows[0]).toMatchObject({ type: 'header', key: 'repo:repo-0' })
    expect(rows.at(-1)).toMatchObject({ type: 'item', worktree: { id: 'wt-129999' } })
  })
})

describe('buildRows Recent project order fallbacks', () => {
  const active: Repo = { ...repo, id: 'repo-active', displayName: 'active', addedAt: 0 }
  // Empty project has no visible worktrees, so Recent falls back to addedAt.
  const empty: Repo = { ...repo, id: 'repo-empty', displayName: 'empty', addedAt: 999 }
  const map = new Map([
    [active.id, active],
    [empty.id, empty]
  ])
  const activeWorktree: Worktree = {
    ...worktree,
    id: 'wt-active',
    repoId: active.id,
    displayName: 'active',
    lastActivityAt: 100
  }

  it('sorts placeholder projects after projects with activity', () => {
    // empty.addedAt (999) is numerically higher than active's worktree (100),
    // but a real activity timestamp must always outrank an addedAt fallback.
    const rows = buildRows(
      'repo',
      [activeWorktree],
      map,
      null,
      new Set(),
      undefined,
      undefined,
      'recent',
      {},
      undefined,
      false,
      undefined,
      [],
      new Set([empty.id])
    )
    const headerKeys = rows.filter((r) => r.type === 'header').map((r) => r.key)
    expect(headerKeys).toEqual(['repo:repo-active', 'repo:repo-empty'])
  })
})

describe('project groups', () => {
  it('keeps empty project groups visible in project grouping mode', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }

    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [group]
    )

    expect(rows).toEqual([
      expect.objectContaining({
        type: 'header',
        key: 'project-group:group-1',
        label: 'Platform',
        count: 0,
        projectGroup: group
      })
    ])
  })

  it('counts grouped repos before their visible worktrees are loaded', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const groupedRepo: Repo = { ...repo, projectGroupId: group.id }

    const rows = buildRows(
      'repo',
      [],
      new Map([[groupedRepo.id, groupedRepo]]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [group],
      new Set([groupedRepo.id])
    )

    expect(rows[0]).toMatchObject({
      type: 'header',
      key: 'project-group:group-1',
      count: 1
    })
    expect(rows[1]).toMatchObject({
      type: 'header',
      key: 'repo:repo-1',
      projectGroupDepth: 1,
      count: 0
    })
  })

  it('does not resurrect filtered repos as empty Project Group headers', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const groupedRepo: Repo = { ...repo, projectGroupId: group.id }

    const rows = buildRows(
      'repo',
      [],
      new Map([[groupedRepo.id, groupedRepo]]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1'
    ])
    expect(rows[0]).toMatchObject({ count: 0 })
  })

  it('renders ungrouped repos as top-level repo rows when Project Groups exist', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }

    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(),
      new Map([[repo.id, 0]]),
      undefined,
      'manual',
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1',
      'repo:repo-1'
    ])
  })

  it('disambiguates duplicate top-level repo basenames without renaming repos', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const paymentsApi: Repo = {
      ...repo,
      id: 'repo-payments-api',
      path: '/workspace/platform/payments/api',
      displayName: 'api'
    }
    const billingApi: Repo = {
      ...repo,
      id: 'repo-billing-api',
      path: '/workspace/platform/billing/api',
      displayName: 'api'
    }
    const webRepo: Repo = {
      ...repo,
      id: 'repo-web',
      path: '/workspace/platform/web',
      displayName: 'web'
    }
    const repos = new Map([
      [paymentsApi.id, paymentsApi],
      [billingApi.id, billingApi],
      [webRepo.id, webRepo]
    ])
    const worktrees = [
      { ...worktree, id: 'wt-payments-api', repoId: paymentsApi.id },
      { ...worktree, id: 'wt-billing-api', repoId: billingApi.id },
      { ...worktree, id: 'wt-web', repoId: webRepo.id }
    ]

    const rows = buildRows(
      'repo',
      worktrees,
      repos,
      null,
      new Set(),
      new Map([
        [paymentsApi.id, 0],
        [billingApi.id, 1],
        [webRepo.id, 2]
      ]),
      undefined,
      'manual',
      {},
      new Map(worktrees.map((entry) => [entry.id, entry])),
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.label)).toEqual([
      'Platform',
      'payments/api',
      'billing/api',
      'web'
    ])
    expect(paymentsApi.displayName).toBe('api')
    expect(billingApi.displayName).toBe('api')
  })

  it('disambiguates duplicate repo basenames inside each Project Group scope', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const paymentsApi: Repo = {
      ...repo,
      id: 'repo-payments-api',
      path: '/workspace/platform/payments/api',
      displayName: 'api',
      projectGroupId: group.id,
      projectGroupOrder: 0
    }
    const billingApi: Repo = {
      ...repo,
      id: 'repo-billing-api',
      path: '/workspace/platform/billing/api',
      displayName: 'api',
      projectGroupId: group.id,
      projectGroupOrder: 1
    }
    const webRepo: Repo = {
      ...repo,
      id: 'repo-web',
      path: '/workspace/platform/web',
      displayName: 'web',
      projectGroupId: group.id,
      projectGroupOrder: 2
    }
    const repos = new Map([
      [paymentsApi.id, paymentsApi],
      [billingApi.id, billingApi],
      [webRepo.id, webRepo]
    ])
    const worktrees = [
      { ...worktree, id: 'wt-payments-api', repoId: paymentsApi.id },
      { ...worktree, id: 'wt-billing-api', repoId: billingApi.id },
      { ...worktree, id: 'wt-web', repoId: webRepo.id }
    ]

    const rows = buildRows(
      'repo',
      worktrees,
      repos,
      null,
      new Set(),
      new Map([
        [paymentsApi.id, 0],
        [billingApi.id, 1],
        [webRepo.id, 2]
      ]),
      undefined,
      'manual',
      {},
      new Map(worktrees.map((entry) => [entry.id, entry])),
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.label)).toEqual([
      'Platform',
      'payments/api',
      'billing/api',
      'web'
    ])
    expect(paymentsApi.displayName).toBe('api')
    expect(billingApi.displayName).toBe('api')
  })

  it('orders repos inside a Project Group by projectGroupOrder in manual mode', () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const repoA: Repo = {
      ...repo,
      id: 'repo-a',
      displayName: 'alpha',
      projectGroupId: group.id,
      projectGroupOrder: 1
    }
    const repoB: Repo = {
      ...repo,
      id: 'repo-b',
      displayName: 'beta',
      projectGroupId: group.id,
      projectGroupOrder: 0
    }
    const worktreeA: Worktree = { ...worktree, id: 'wt-a', repoId: repoA.id }
    const worktreeB: Worktree = { ...worktree, id: 'wt-b', repoId: repoB.id }
    const groupedMap = new Map([
      [repoA.id, repoA],
      [repoB.id, repoB]
    ])
    const repoOrder = new Map([
      [repoA.id, 0],
      [repoB.id, 1]
    ])

    const rows = buildRows(
      'repo',
      [worktreeA, worktreeB],
      groupedMap,
      null,
      new Set(),
      repoOrder,
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      [group]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1',
      'repo:repo-b',
      'repo:repo-a'
    ])
  })

  it('orders repos inside a Project Group by activity in recent mode, keeping tabOrder', () => {
    const groupA: ProjectGroup = {
      id: 'group-a',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 1,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const groupB: ProjectGroup = { ...groupA, id: 'group-b', name: 'Infra', tabOrder: 0 }
    // Inside group A: repoStale ordered first by projectGroupOrder, but repoFresh
    // is more recently active so recent mode must lift it above repoStale.
    const repoStale: Repo = {
      ...repo,
      id: 'repo-stale',
      displayName: 'stale',
      projectGroupId: groupA.id,
      projectGroupOrder: 0
    }
    const repoFresh: Repo = {
      ...repo,
      id: 'repo-fresh',
      displayName: 'fresh',
      projectGroupId: groupA.id,
      projectGroupOrder: 1
    }
    const groupedMap = new Map([
      [repoStale.id, repoStale],
      [repoFresh.id, repoFresh]
    ])
    const worktrees = [
      { ...worktree, id: 'wt-stale', repoId: repoStale.id, lastActivityAt: 10 },
      { ...worktree, id: 'wt-fresh', repoId: repoFresh.id, lastActivityAt: 500 }
    ]

    const rows = buildRows(
      'repo',
      worktrees,
      groupedMap,
      null,
      new Set(),
      undefined,
      undefined,
      'recent',
      {},
      new Map(worktrees.map((entry) => [entry.id, entry])),
      false,
      undefined,
      // Group headers always follow tabOrder (Infra=0 before Platform=1),
      // independent of projectOrderBy.
      [groupA, groupB]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-b',
      'project-group:group-a',
      'repo:repo-fresh',
      'repo:repo-stale'
    ])
  })

  it('renders nested Project Groups before repos assigned to their leaf group', () => {
    const rootGroup: ProjectGroup = {
      id: 'group-root',
      name: 'Services',
      parentPath: '/monorepo',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const childGroup: ProjectGroup = {
      ...rootGroup,
      id: 'group-payments',
      name: 'payments',
      parentPath: '/monorepo/services/payments',
      parentGroupId: rootGroup.id,
      tabOrder: 1
    }
    const groupedRepo: Repo = {
      ...repo,
      id: 'repo-payments-api',
      displayName: 'api',
      projectGroupId: childGroup.id,
      projectGroupOrder: 0
    }
    const groupedWorktree: Worktree = {
      ...worktree,
      id: 'wt-payments-api',
      repoId: groupedRepo.id
    }

    const rows = buildRows(
      'repo',
      [groupedWorktree],
      new Map([[groupedRepo.id, groupedRepo]]),
      null,
      new Set(),
      new Map([[groupedRepo.id, 0]]),
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      [rootGroup, childGroup]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-root',
      'project-group:group-payments',
      'repo:repo-payments-api'
    ])
    expect(rows.filter((row) => row.type === 'header').map((row) => row.projectGroupDepth)).toEqual(
      [0, 1, 2]
    )
    expect(rows.find((row) => row.type === 'item')).toMatchObject({
      type: 'item',
      groupDepth: 2
    })
    expect(rows[0]).toMatchObject({ count: 1 })
  })

  it('renders folder workspaces under their owning folder-backed Project Group', () => {
    const group: ProjectGroup = {
      id: 'group-root',
      name: 'Platform',
      parentPath: '/monorepo',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-workspace-1',
      projectGroupId: group.id,
      name: 'Refund fix',
      folderPath: '/monorepo',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 10,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }

    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [group],
      new Set(),
      new Map(),
      [],
      undefined,
      [folderWorkspace]
    )

    expect(rows).toMatchObject([
      {
        type: 'header',
        key: 'project-group:group-root',
        count: 1
      },
      {
        type: 'folder-workspace',
        folderWorkspace: { id: 'folder-workspace-1' },
        projectGroup: { id: 'group-root' },
        groupDepth: 1
      }
    ])
  })

  it('preserves nested Project Group depth for folder workspace rows', () => {
    const rootGroup: ProjectGroup = {
      id: 'group-root',
      name: 'Platform',
      parentPath: '/monorepo',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const childGroup: ProjectGroup = {
      id: 'group-shared',
      name: 'packages/shared',
      parentPath: '/monorepo/packages/shared',
      parentGroupId: rootGroup.id,
      createdFrom: 'folder-scan',
      tabOrder: 1,
      isCollapsed: false,
      color: null,
      createdAt: 2,
      updatedAt: 2
    }
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-workspace-nested',
      projectGroupId: childGroup.id,
      name: 'Shared package work',
      folderPath: '/monorepo/packages/shared',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 10,
      lastActivityAt: 0,
      createdAt: 3,
      updatedAt: 3
    }

    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [rootGroup, childGroup],
      new Set(),
      new Map(),
      [],
      undefined,
      [folderWorkspace]
    )

    expect(rows).toMatchObject([
      {
        type: 'header',
        key: 'project-group:group-root',
        projectGroupDepth: 0
      },
      {
        type: 'header',
        key: 'project-group:group-shared',
        projectGroupDepth: 1
      },
      {
        type: 'folder-workspace',
        folderWorkspace: { id: 'folder-workspace-nested' },
        groupDepth: 2
      }
    ])
  })

  it('does not render folder workspaces under non-folder Project Groups', () => {
    const group: ProjectGroup = {
      id: 'group-manual',
      name: 'Manual',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-workspace-1',
      projectGroupId: group.id,
      name: 'Hidden',
      folderPath: '/monorepo',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 10,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }

    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [group],
      new Set(),
      new Map(),
      [],
      undefined,
      [folderWorkspace]
    )

    expect(rows).toMatchObject([
      {
        type: 'header',
        key: 'project-group:group-manual',
        count: 0
      }
    ])
    expect(rows.some((row) => row.type === 'folder-workspace')).toBe(false)
  })

  it('renders imported repos under nested Project Groups before worktree rows load', () => {
    const rootGroup: ProjectGroup = {
      id: 'group-root',
      name: 'Root',
      parentPath: '/monorepo',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const platformGroup: ProjectGroup = {
      ...rootGroup,
      id: 'group-platform',
      name: 'Platform',
      parentGroupId: rootGroup.id,
      tabOrder: 1
    }
    const servicesGroup: ProjectGroup = {
      ...rootGroup,
      id: 'group-services',
      name: 'Services',
      parentGroupId: platformGroup.id,
      tabOrder: 2
    }
    const serviceA: Repo = {
      ...repo,
      id: 'repo-service-a',
      displayName: 'service-a',
      projectGroupId: servicesGroup.id,
      projectGroupOrder: 0
    }
    const serviceB: Repo = {
      ...repo,
      id: 'repo-service-b',
      displayName: 'service-b',
      projectGroupId: servicesGroup.id,
      projectGroupOrder: 1
    }

    const rows = buildRows(
      'repo',
      [],
      new Map([
        [serviceA.id, serviceA],
        [serviceB.id, serviceB]
      ]),
      null,
      new Set(),
      new Map([
        [serviceA.id, 0],
        [serviceB.id, 1]
      ]),
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      [rootGroup, platformGroup, servicesGroup],
      new Set([serviceA.id, serviceB.id])
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-root',
      'project-group:group-platform',
      'project-group:group-services',
      'repo:repo-service-a',
      'repo:repo-service-b'
    ])
    expect(rows.filter((row) => row.type === 'header').map((row) => row.count)).toEqual([
      2, 2, 2, 0, 0
    ])
  })

  it('returns both parent Project Group and repo keys for grouped repo reveals', () => {
    const groupedRepo: Repo = { ...repo, projectGroupId: 'group-1' }

    expect(
      getGroupKeysForWorktree('repo', worktree, new Map([[groupedRepo.id, groupedRepo]]), null)
    ).toEqual(['project-group:group-1', 'repo:repo-1'])
  })

  it('returns only the repo key for ungrouped repo reveals', () => {
    expect(getGroupKeysForWorktree('repo', worktree, repoMap, null)).toEqual(['repo:repo-1'])
  })
})

describe('buildRows workspace lineage nesting', () => {
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

    const items = rows.filter((row) => row.type === 'item')
    expect(items[0]).toMatchObject({
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
      ])
    )

    expect(info).toMatchObject({ state: 'missing' })
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

describe('WorktreeList header styles', () => {
  it('does not title-case workspace group labels', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./WorktreeList.tsx', import.meta.url)),
      'utf8'
    )

    expect(source).not.toContain('leading-none capitalize')
  })

  it('shows a pointer cursor over the disclosure chevron path', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./WorktreeList.tsx', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('[&_path]:cursor-pointer')
  })

  it('resolves repo header color from project group headers only', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./WorktreeList.tsx', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('resolveProjectGroupHeaderColor({')
    expect(source).toContain('headerKey: row.key')
    expect(source).toContain('color={repoHeaderColor}')
  })
})

describe('buildRows pending creations', () => {
  function makePendingCreation(creationId: string, repoId: string): PendingCreationRef {
    return { creationId, repoId }
  }

  it('nests a pending creation under its repo, above the repo worktrees', () => {
    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      [makePendingCreation('c1', repo.id)]
    )

    const types = rows.map((row) => row.type)
    const headerIndex = types.indexOf('header')
    const pendingIndex = rows.findIndex(
      (row) => row.type === 'pending-creation' && row.creationId === 'c1'
    )
    const itemIndex = types.indexOf('item')
    expect(headerIndex).toBeGreaterThanOrEqual(0)
    expect(pendingIndex).toBe(headerIndex + 1)
    expect(pendingIndex).toBeLessThan(itemIndex)
  })

  it('creates a repo group for a pending creation in a repo with no worktrees yet', () => {
    const rows = buildRows(
      'repo',
      [],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      [makePendingCreation('c1', repo.id)]
    )

    expect(rows.map((row) => row.type)).toEqual(['header', 'pending-creation'])
  })

  it('keeps a pending creation visible when its repo metadata is temporarily missing', () => {
    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      [makePendingCreation('c1', repo.id)]
    )

    expect(rows).toMatchObject([
      { type: 'header', key: `repo:${repo.id}`, label: 'Unknown' },
      { type: 'pending-creation', creationId: 'c1', repo: undefined }
    ])
  })

  it('surfaces pending creations at the top for non-repo groupings', () => {
    const rows = buildRows(
      'none',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      [makePendingCreation('c1', repo.id)]
    )

    expect(rows[0]).toMatchObject({ type: 'pending-creation', creationId: 'c1' })
  })
})
