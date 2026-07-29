/* eslint-disable max-lines -- Why: row-builder tests keep grouping, pinning, and lineage ordering cases together so expected row contracts stay comparable. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import {
  ALL_GROUP_META,
  buildRows,
  getGroupKeyForWorktree,
  getGroupKeysForWorktree,
  getLineageGroupKey,
  getLineageRenderInfo,
  getPRGroupKey,
  PINNED_GROUP_KEY,
  type PendingCreationRef
} from './worktree-list-groups'
import {
  REPO_HEADER_ACTION_BUTTON_CLASS,
  REPO_HEADER_ACTION_REVEAL_CLASS
} from './repo-header-action-button-class'
import { getWorktreeLineageAncestors } from './worktree-lineage-projection'
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

const LOCAL_HOST_LABEL = getExecutionHostLabel('local')

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

function readWorktreeListSource(): string {
  return readFileSync(fileURLToPath(new URL('./WorktreeList.tsx', import.meta.url)), 'utf8')
}

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

  it('uses local PR cache for a known local repo while a runtime is focused', () => {
    const prCache = {
      'repo-1::feature/super-critical': {
        data: { state: 'merged' }
      }
    }

    expect(
      getPRGroupKey(worktree, repoMap, prCache, {
        activeRuntimeEnvironmentId: 'env-1'
      } as never)
    ).toBe('done')
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
    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned', label: 'Pinned' })
    expect(rows[1]).toMatchObject({ type: 'item', worktree: { id: 'wt-pinned' } })
    expect(rows[2]).toMatchObject({ type: 'header', key: 'all', label: 'All', count: 2 })
    expect(rows[2]).toMatchObject({ type: 'header', icon: ALL_GROUP_META.icon })
  })

  it('uses worktree host ownership for pinned header host counts', () => {
    const runtimePinned = {
      ...pinned,
      hostId: 'runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3' as const
    }

    const rows = buildRows(
      'none',
      [runtimePinned, unpinned1],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [runtimePinned.id, runtimePinned],
        [unpinned1.id, unpinned1]
      ])
    )
    const pinnedHeader = rows[0]

    expect(pinnedHeader).toMatchObject({ type: 'header', key: 'pinned' })
    expect(pinnedHeader.type === 'header' ? pinnedHeader.hostWorktreeCounts : undefined).toEqual(
      new Map([['runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3', 1]])
    )
  })

  it('groups all worktrees under All in groupBy none', () => {
    const rows = buildRows('none', [unpinned1, unpinned2], repoMap, null, new Set())

    expect(rows).toMatchObject([
      { type: 'header', key: 'all', label: 'All' },
      { type: 'item', worktree: { id: 'wt-1' } },
      { type: 'item', worktree: { id: 'wt-2' } }
    ])
  })

  it('moves pinned worktrees out of the All group', () => {
    const rows = buildRows('none', [unpinned1, pinned, unpinned2], repoMap, null, new Set())

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned' },
      { type: 'item', worktree: { id: 'wt-pinned' } },
      { type: 'header', key: 'all', count: 2 },
      { type: 'item', worktree: { id: 'wt-1' } },
      { type: 'item', worktree: { id: 'wt-2' } }
    ])
  })

  it('duplicates pinned worktrees into All when the policy allows it', () => {
    const rows = buildRows(
      'none',
      [unpinned1, pinned, unpinned2],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      false,
      { showPinnedWorktreesInGroups: true } as never
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned' },
      { type: 'item', sectionKey: PINNED_GROUP_KEY, worktree: { id: 'wt-pinned' } },
      { type: 'header', key: 'all', count: 3 },
      { type: 'item', sectionKey: 'all', worktree: { id: 'wt-1' } },
      { type: 'item', sectionKey: 'all', worktree: { id: 'wt-pinned' } },
      { type: 'item', sectionKey: 'all', worktree: { id: 'wt-2' } }
    ])
  })

  it('collapses the All group in groupBy none', () => {
    const rows = buildRows('none', [unpinned1, pinned, unpinned2], repoMap, null, new Set(['all']))

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned' },
      { type: 'item', worktree: { id: 'wt-pinned' } },
      { type: 'header', key: 'all', count: 2 }
    ])
  })

  it('emits status headers for unpinned matching worktrees in groupBy workspace-status', () => {
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
      count: 2
    })
    expect(rows[3]).toMatchObject({ type: 'item', worktree: { id: 'wt-1' } })
    expect(rows[4]).toMatchObject({ type: 'item', worktree: { id: 'wt-2' } })
  })

  it('duplicates pinned worktrees into status groups when the policy allows it', () => {
    const rows = buildRows(
      'workspace-status',
      [unpinned1, pinned],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      false,
      { showPinnedWorktreesInGroups: true } as never
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned', count: 1 },
      { type: 'item', sectionKey: PINNED_GROUP_KEY, worktree: { id: 'wt-pinned' } },
      { type: 'header', key: 'workspace-status:in-progress', count: 2 },
      { type: 'item', sectionKey: 'workspace-status:in-progress', worktree: { id: 'wt-1' } },
      { type: 'item', sectionKey: 'workspace-status:in-progress', worktree: { id: 'wt-pinned' } }
    ])
  })

  it('moves pinned items out of regular groups in pr-status mode', () => {
    const rows = buildRows('pr-status', [unpinned1, pinned], repoMap, null, new Set())
    const pinnedHeader = rows.find((r) => r.type === 'header' && r.key === 'pinned')
    expect(pinnedHeader).toBeDefined()
    const prGroup = rows.filter((r) => r.type === 'header' && r.key.startsWith('pr:'))
    for (const header of prGroup) {
      if (header.type === 'header') {
        expect(header.count).toBe(1)
      }
    }
  })

  it('omits empty pinned sections in groupBy workspace-status', () => {
    const rows = buildRows('workspace-status', [unpinned1, unpinned2], repoMap, null, new Set())
    expect(rows[0]).toMatchObject({
      type: 'header',
      key: 'workspace-status:in-progress',
      label: 'In progress'
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
    expect(rows[2]).toMatchObject({ type: 'item', worktree: { id: 'wt-1' } })
  })

  it('omits status sections when all matching worktrees are pinned', () => {
    const allPinned = { ...unpinned1, isPinned: true }
    const rows = buildRows('workspace-status', [pinned, allPinned], repoMap, null, new Set())
    expect(rows.filter((r) => r.type === 'header')).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned', count: 2 })
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
      new Map(),
      [],
      { projects: [project], projectHostSetups }
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'project:github:stablyai/orca', label: 'Orca', count: 2 },
      { type: 'item', worktree: { id: worktree.id }, hostContextLabel: LOCAL_HOST_LABEL },
      { type: 'item', worktree: { id: remoteWorktree.id }, hostContextLabel: 'gpu-vm' }
    ])
  })

  it('renders same-project records with git remote identity as one mixed-host project header', () => {
    const localRepo: Repo = {
      ...repo,
      id: 'local-sample-app',
      path: '/Users/alice/work/sample-app',
      displayName: 'sample-app',
      gitRemoteIdentity: {
        canonicalKey: 'git.company.test/team/sample-app',
        remoteName: 'origin',
        remoteUrl: 'git@git.company.test:team/sample-app.git'
      }
    }
    const sshRepo: Repo = {
      ...repo,
      id: 'ssh-sample-app',
      path: '/home/alice/src/sample-app',
      displayName: 'sample-app',
      connectionId: 'build server',
      gitRemoteIdentity: {
        canonicalKey: 'git.company.test/team/sample-app',
        remoteName: 'origin',
        remoteUrl: 'https://git.company.test/team/sample-app.git'
      }
    }
    const runtimeRepo: Repo = {
      ...repo,
      id: 'runtime-sample-app',
      path: '/workspace/sample-app',
      displayName: 'sample-app',
      executionHostId: 'runtime:dev-container',
      gitRemoteIdentity: {
        canonicalKey: 'git.company.test/team/sample-app',
        remoteName: 'origin',
        remoteUrl: 'ssh://git@git.company.test/team/sample-app.git'
      }
    }
    const localWorktree: Worktree = {
      ...worktree,
      id: 'wt-local-sample-app',
      repoId: localRepo.id,
      path: '/Users/alice/work/sample-app-feature'
    }
    const sshWorktree: Worktree = {
      ...worktree,
      id: 'wt-ssh-sample-app',
      repoId: sshRepo.id,
      path: '/home/alice/src/sample-app-feature'
    }
    const runtimeWorktree: Worktree = {
      ...worktree,
      id: 'wt-runtime-sample-app',
      repoId: runtimeRepo.id,
      path: '/workspace/sample-app-feature'
    }
    const projection = projectHostSetupProjectionFromRepos([localRepo, sshRepo, runtimeRepo])
    const rows = buildRows(
      'repo',
      [localWorktree, sshWorktree, runtimeWorktree],
      new Map([
        [localRepo.id, localRepo],
        [sshRepo.id, sshRepo],
        [runtimeRepo.id, runtimeRepo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [localWorktree.id, localWorktree],
        [sshWorktree.id, sshWorktree],
        [runtimeWorktree.id, runtimeWorktree]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [],
      {
        projects: projection.projects,
        projectHostSetups: projection.setups
      }
    )

    expect(rows).toMatchObject([
      {
        type: 'header',
        key: 'project:git:git.company.test/team/sample-app',
        label: 'sample-app',
        count: 3
      },
      { type: 'item', worktree: { id: localWorktree.id }, hostContextLabel: LOCAL_HOST_LABEL },
      { type: 'item', worktree: { id: sshWorktree.id }, hostContextLabel: 'build server' },
      { type: 'item', worktree: { id: runtimeWorktree.id }, hostContextLabel: 'dev-container' }
    ])
  })

  it('keeps mixed-host project item order while inserting inbox rows before worktrees', () => {
    const localRepo: Repo = {
      ...repo,
      id: 'local-sample-app',
      displayName: 'sample-app',
      gitRemoteIdentity: {
        canonicalKey: 'git.company.test/team/sample-app',
        remoteName: 'origin',
        remoteUrl: 'https://git.company.test/team/sample-app.git'
      }
    }
    const sshRepo: Repo = {
      ...repo,
      id: 'ssh-sample-app',
      path: '/home/alice/src/sample-app',
      displayName: 'sample-app',
      connectionId: 'build server',
      gitRemoteIdentity: {
        canonicalKey: 'git.company.test/team/sample-app',
        remoteName: 'origin',
        remoteUrl: 'https://git.company.test/team/sample-app.git'
      }
    }
    const localFirst: Worktree = {
      ...worktree,
      id: 'wt-local-first',
      repoId: localRepo.id,
      path: '/Users/alice/work/sample-app-a'
    }
    const sshWorktree: Worktree = {
      ...worktree,
      id: 'wt-ssh',
      repoId: sshRepo.id,
      path: '/home/alice/src/sample-app-b'
    }
    const localSecond: Worktree = {
      ...worktree,
      id: 'wt-local-second',
      repoId: localRepo.id,
      path: '/Users/alice/work/sample-app-c'
    }
    const projection = projectHostSetupProjectionFromRepos([localRepo, sshRepo])
    const rows = buildRows(
      'repo',
      [localFirst, sshWorktree, localSecond],
      new Map([
        [localRepo.id, localRepo],
        [sshRepo.id, sshRepo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [localFirst.id, localFirst],
        [sshWorktree.id, sshWorktree],
        [localSecond.id, localSecond]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map([
        [
          localRepo.id,
          { repo: localRepo, inboxWorktrees: [makeDetectedWorktree({ id: 'local-inbox' })] }
        ],
        [sshRepo.id, { repo: sshRepo, inboxWorktrees: [makeDetectedWorktree({ id: 'ssh-inbox' })] }]
      ]),
      [],
      {
        projects: projection.projects,
        projectHostSetups: projection.setups
      }
    )

    expect(rows).toMatchObject([
      { type: 'header' },
      { type: 'new-external-worktrees-inbox', repo: { id: localRepo.id } },
      { type: 'new-external-worktrees-inbox', repo: { id: sshRepo.id } },
      { type: 'item', worktree: { id: localFirst.id } },
      { type: 'item', worktree: { id: sshWorktree.id } },
      { type: 'item', worktree: { id: localSecond.id } }
    ])
  })

  it('orders project identity headers by the manual repo order anchor', () => {
    const analyticsProject: Project = {
      ...project,
      id: 'github:stablyai/analytics',
      displayName: 'Analytics',
      sourceRepoIds: ['repo-analytics']
    }
    const analyticsRepo: Repo = {
      ...repo,
      id: 'repo-analytics',
      path: '/tmp/analytics',
      displayName: 'analytics',
      upstream: { owner: 'stablyai', repo: 'analytics' }
    }
    const analyticsWorktree: Worktree = {
      ...worktree,
      id: 'wt-analytics',
      repoId: analyticsRepo.id,
      displayName: 'analytics'
    }
    const analyticsSetup: ProjectHostSetup = {
      ...projectHostSetups[0]!,
      id: analyticsRepo.id,
      projectId: analyticsProject.id,
      repoId: analyticsRepo.id,
      path: analyticsRepo.path,
      displayName: analyticsRepo.displayName
    }
    const repoOrder = new Map([
      [repo.id, 0],
      [remoteRepo.id, 1],
      [analyticsRepo.id, 2]
    ])

    const rows = buildRows(
      'repo',
      [worktree, analyticsWorktree, remoteWorktree],
      new Map([
        [repo.id, repo],
        [remoteRepo.id, remoteRepo],
        [analyticsRepo.id, analyticsRepo]
      ]),
      null,
      new Set(),
      repoOrder,
      undefined,
      'manual',
      {},
      new Map([
        [worktree.id, worktree],
        [remoteWorktree.id, remoteWorktree],
        [analyticsWorktree.id, analyticsWorktree]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [],
      {
        projects: [project, analyticsProject],
        projectHostSetups: [...projectHostSetups, analyticsSetup]
      }
    )

    const headers = rows.filter((row) => row.type === 'header')
    expect(headers.map((row) => row.key)).toEqual([
      'project:github:stablyai/orca',
      'project:github:stablyai/analytics'
    ])
    expect(headers[0]).toMatchObject({
      key: 'project:github:stablyai/orca',
      repo: { id: repo.id, badgeColor: repo.badgeColor }
    })
  })

  it('splits same-host checkouts of one project into separate per-setup groups', () => {
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

  it('splits all project setups when one host has duplicate checkouts', () => {
    const localRepoB: Repo = {
      ...repo,
      id: 'repo-local-b',
      path: '/tmp/orca-b',
      displayName: 'orca-b'
    }
    const localWorktreeB: Worktree = {
      ...worktree,
      id: 'wt-local-b',
      repoId: localRepoB.id,
      path: '/tmp/orca-b-feature',
      displayName: 'feature-b'
    }
    const localSetupB: ProjectHostSetup = {
      ...projectHostSetups[0]!,
      id: localRepoB.id,
      repoId: localRepoB.id,
      path: localRepoB.path,
      displayName: localRepoB.displayName
    }
    const rows = buildRows(
      'repo',
      [worktree, localWorktreeB, remoteWorktree],
      new Map([
        [repo.id, repo],
        [localRepoB.id, localRepoB],
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
        [localWorktreeB.id, localWorktreeB],
        [remoteWorktree.id, remoteWorktree]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [],
      {
        projects: [{ ...project, sourceRepoIds: [repo.id, localRepoB.id, remoteRepo.id] }],
        projectHostSetups: [projectHostSetups[0]!, localSetupB, projectHostSetups[1]!]
      }
    )

    const headers = rows.filter((row) => row.type === 'header')
    expect(headers.map((row) => row.key)).toEqual([
      'project:github:stablyai/orca::setup:repo-1',
      'project:github:stablyai/orca::setup:repo-local-b',
      'project:github:stablyai/orca::setup:repo-remote'
    ])
  })

  it('keeps a provisioned runtime copy under the project header alongside a same-host checkout', () => {
    const runtimeRepoB: Repo = {
      ...repo,
      id: 'repo-runtime-b',
      path: '/tmp/orca-runtime-b',
      displayName: 'orca-runtime-b'
    }
    const runtimeWorktreeB: Worktree = {
      ...worktree,
      id: 'wt-runtime-b',
      repoId: runtimeRepoB.id,
      path: '/tmp/orca-runtime-b-feature',
      displayName: 'feature-runtime-b'
    }
    // Why: a `provisioned` (recipe-created ephemeral) copy shares the project's
    // remote identity but must not split the user's real checkout into two
    // headers; it nests under the project. See #6320 / #5374.
    const runtimeSetupB: ProjectHostSetup = {
      ...projectHostSetups[0]!,
      id: runtimeRepoB.id,
      repoId: runtimeRepoB.id,
      path: runtimeRepoB.path,
      displayName: runtimeRepoB.displayName,
      setupMethod: 'provisioned'
    }
    const rows = buildRows(
      'repo',
      [worktree, runtimeWorktreeB],
      new Map([
        [repo.id, repo],
        [runtimeRepoB.id, runtimeRepoB]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [worktree.id, worktree],
        [runtimeWorktreeB.id, runtimeWorktreeB]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [],
      {
        projects: [{ ...project, sourceRepoIds: [repo.id, runtimeRepoB.id] }],
        projectHostSetups: [projectHostSetups[0]!, runtimeSetupB]
      }
    )

    const headers = rows.filter((row) => row.type === 'header')
    expect(headers).toHaveLength(1)
    expect(headers[0]).toMatchObject({
      key: 'project:github:stablyai/orca',
      label: 'Orca',
      count: 2
    })
  })

  it('splits duplicate user checkouts while a provisioned copy nests, on one host', () => {
    // Why: guards the intersection of #5374 (real same-host checkouts split) and
    // #6320 (provisioned copies nest). Two legacy checkouts must each get their own
    // header while a provisioned copy of the same project stays under the plain
    // project header — all on one host surface, simultaneously.
    const localRepoB: Repo = {
      ...repo,
      id: 'repo-local-b',
      path: '/tmp/orca-b',
      displayName: 'orca-b'
    }
    const localWorktreeB: Worktree = {
      ...worktree,
      id: 'wt-local-b',
      repoId: localRepoB.id,
      path: '/tmp/orca-b-feature',
      displayName: 'feature-b'
    }
    const localSetupB: ProjectHostSetup = {
      ...projectHostSetups[0]!,
      id: localRepoB.id,
      repoId: localRepoB.id,
      path: localRepoB.path,
      displayName: localRepoB.displayName
    }
    const runtimeRepoB: Repo = {
      ...repo,
      id: 'repo-runtime-b',
      path: '/tmp/orca-runtime-b',
      displayName: 'orca-runtime-b'
    }
    const runtimeWorktreeB: Worktree = {
      ...worktree,
      id: 'wt-runtime-b',
      repoId: runtimeRepoB.id,
      path: '/tmp/orca-runtime-b-feature',
      displayName: 'feature-runtime-b'
    }
    const runtimeSetupB: ProjectHostSetup = {
      ...projectHostSetups[0]!,
      id: runtimeRepoB.id,
      repoId: runtimeRepoB.id,
      path: runtimeRepoB.path,
      displayName: runtimeRepoB.displayName,
      setupMethod: 'provisioned'
    }
    const rows = buildRows(
      'repo',
      [worktree, localWorktreeB, runtimeWorktreeB],
      new Map([
        [repo.id, repo],
        [localRepoB.id, localRepoB],
        [runtimeRepoB.id, runtimeRepoB]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [worktree.id, worktree],
        [localWorktreeB.id, localWorktreeB],
        [runtimeWorktreeB.id, runtimeWorktreeB]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [],
      {
        projects: [{ ...project, sourceRepoIds: [repo.id, localRepoB.id, runtimeRepoB.id] }],
        projectHostSetups: [projectHostSetups[0]!, localSetupB, runtimeSetupB]
      }
    )

    const headers = rows.filter((row) => row.type === 'header')
    expect(headers.map((row) => row.key).sort()).toEqual([
      'project:github:stablyai/orca',
      'project:github:stablyai/orca::setup:repo-1',
      'project:github:stablyai/orca::setup:repo-local-b'
    ])
    // The provisioned copy nests under the plain project key with only its own
    // worktree; it never gets a path-scoped `::setup:` header like the real
    // checkouts do. (buildRows disambiguates its visible label to the repo name.)
    expect(
      headers.some((row) => row.key === 'project:github:stablyai/orca::setup:repo-runtime-b')
    ).toBe(false)
    expect(headers.find((row) => row.key === 'project:github:stablyai/orca')).toMatchObject({
      count: 1
    })
  })

  it('groups Windows host and WSL setups on the same runtime host', () => {
    const runtimeHostId = 'runtime:g16'
    const windowsRepo: Repo = {
      ...repo,
      id: 'repo-windows',
      path: String.raw`C:\Users\alice\git\orca`,
      displayName: 'orca',
      executionHostId: runtimeHostId
    }
    const wslRepo: Repo = {
      ...repo,
      id: 'repo-wsl',
      path: String.raw`\\wsl.localhost\Ubuntu\home\alice\git\orca`,
      displayName: 'orca',
      executionHostId: runtimeHostId
    }
    const windowsWorktree: Worktree = {
      ...worktree,
      id: 'wt-windows',
      repoId: windowsRepo.id,
      path: String.raw`C:\Users\alice\git\orca\feature`
    }
    const wslWorktree: Worktree = {
      ...worktree,
      id: 'wt-wsl',
      repoId: wslRepo.id,
      path: String.raw`\\wsl.localhost\Ubuntu\home\alice\git\orca\feature`
    }
    const windowsSetup: ProjectHostSetup = {
      ...projectHostSetups[0]!,
      id: windowsRepo.id,
      hostId: runtimeHostId,
      repoId: windowsRepo.id,
      path: windowsRepo.path,
      displayName: windowsRepo.displayName
    }
    const wslSetup: ProjectHostSetup = {
      ...windowsSetup,
      id: wslRepo.id,
      repoId: wslRepo.id,
      path: wslRepo.path
    }
    const rows = buildRows(
      'repo',
      [windowsWorktree, wslWorktree],
      new Map([
        [windowsRepo.id, windowsRepo],
        [wslRepo.id, wslRepo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [windowsWorktree.id, windowsWorktree],
        [wslWorktree.id, wslWorktree]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [],
      {
        projects: [{ ...project, sourceRepoIds: [windowsRepo.id, wslRepo.id] }],
        projectHostSetups: [windowsSetup, wslSetup]
      }
    )

    expect(rows.filter((row) => row.type === 'header')).toMatchObject([
      {
        key: 'project:github:stablyai/orca',
        label: 'Orca',
        count: 2
      }
    ])
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
      new Map(),
      [],
      { projects: [project], projectHostSetups: [projectHostSetups[0]!, runtimeSetup] },
      [],
      new Map([
        ['local', LOCAL_HOST_LABEL],
        ['runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3', 'dev box']
      ])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'project:github:stablyai/orca', label: 'Orca', count: 2 },
      { type: 'item', worktree: { id: worktree.id }, hostContextLabel: LOCAL_HOST_LABEL },
      { type: 'item', worktree: { id: runtimeWorktree.id }, hostContextLabel: 'dev box' }
    ])
  })

  it('shows distinct Orca server names when status grouping mixes runtime hosts', () => {
    const firstRepo: Repo = {
      ...repo,
      id: 'repo-runtime-a',
      executionHostId: 'runtime:env-a'
    }
    const secondRepo: Repo = {
      ...repo,
      id: 'repo-runtime-b',
      executionHostId: 'runtime:env-b'
    }
    const firstWorktree: Worktree = {
      ...worktree,
      id: 'wt-runtime-a',
      repoId: firstRepo.id
    }
    const secondWorktree: Worktree = {
      ...worktree,
      id: 'wt-runtime-b',
      repoId: secondRepo.id
    }
    const rows = buildRows(
      'workspace-status',
      [firstWorktree, secondWorktree],
      new Map([
        [firstRepo.id, firstRepo],
        [secondRepo.id, secondRepo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [firstWorktree.id, firstWorktree],
        [secondWorktree.id, secondWorktree]
      ]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [],
      undefined,
      [],
      new Map([
        ['runtime:env-a', 'Remote Mac'],
        ['runtime:env-b', 'Build Linux']
      ])
    )

    expect(rows.filter((row) => row.type === 'item')).toMatchObject([
      { worktree: { id: firstWorktree.id }, hostContextLabel: 'Remote Mac' },
      { worktree: { id: secondWorktree.id }, hostContextLabel: 'Build Linux' }
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
      { type: 'header', key: 'repo:repo-1' },
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
      { type: 'header', key: 'repo:repo-1', label: 'orca' },
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

  it('places non-repo imported fallbacks after each repo last pinned row when expanded', () => {
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
      'none',
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

    expect(
      rows.map((row) =>
        row.type === 'item'
          ? row.worktree.id
          : row.type === 'imported-worktrees-card'
            ? `${row.placement}:${row.repo.id}`
            : row.key
      )
    ).toEqual([
      'pinned',
      'repo-1-pinned-a',
      'repo-2-pinned',
      'pinned-fallback:repo-2',
      'repo-1-pinned-b',
      'pinned-fallback:repo-1'
    ])
  })

  it('places collapsed non-repo imported fallbacks after Pinned in pinned repo order', () => {
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
      'workspace-status',
      [pinnedOneA, pinnedTwo, pinnedOneB],
      new Map([
        [repo.id, repo],
        [repoTwo.id, repoTwo]
      ]),
      null,
      new Set([PINNED_GROUP_KEY]),
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

    expect(rows).toMatchObject([
      { type: 'header', key: PINNED_GROUP_KEY, count: 3 },
      { type: 'imported-worktrees-card', placement: 'pinned-fallback', repo: { id: repo.id } },
      { type: 'imported-worktrees-card', placement: 'pinned-fallback', repo: { id: repoTwo.id } }
    ])
  })

  it('emits a new external worktrees inbox row before repo worktree rows', () => {
    const inboxWorktrees = [
      makeDetectedWorktree({ id: 'inbox-1', displayName: 'payments-refactor' }),
      makeDetectedWorktree({ id: 'inbox-2', displayName: 'auth-cache-debug' })
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
      new Map(),
      new Map([[repo.id, { repo, inboxWorktrees }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1' },
      {
        type: 'new-external-worktrees-inbox',
        key: 'new-external-worktrees-inbox:repo-1',
        repo: { id: 'repo-1' },
        inboxWorktrees: [{ id: 'inbox-1' }, { id: 'inbox-2' }]
      },
      { type: 'item', worktree: { id: 'wt-1' } }
    ])
  })

  it('suppresses the new external worktrees inbox row when the repo group is collapsed', () => {
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
      new Map(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([{ type: 'header', key: 'repo:repo-1' }])
  })

  it('emits a repo header and inbox row when no visible worktree rows remain', () => {
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
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1' },
      {
        type: 'new-external-worktrees-inbox',
        key: 'new-external-worktrees-inbox:repo-1'
      }
    ])
  })

  it('keeps the inbox group when the repo only has a pinned worktree', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: pinnedWorktree.id })
        }),
        expect.objectContaining({ type: 'header', key: `repo:${repo.id}` }),
        expect.objectContaining({
          type: 'new-external-worktrees-inbox',
          key: `new-external-worktrees-inbox:${repo.id}`
        })
      ])
    )
    expect(
      rows.some(
        (row) =>
          row.type === 'item' &&
          row.sectionKey === `repo:${repo.id}` &&
          row.worktree.id === pinnedWorktree.id
      )
    ).toBe(false)
  })

  it('does not emit new external worktrees inbox rows outside repo grouping', () => {
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
      new Map(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows.some((row) => row.type === 'new-external-worktrees-inbox')).toBe(false)
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
    expect(
      rows.filter((row) => row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY)
    ).toEqual([])
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: 'repo-1-pinned-a' })
        }),
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: 'repo-1-pinned-b' })
        }),
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: 'repo-2-pinned' })
        })
      ])
    )
  })

  it('duplicates pinned worktrees into repo groups when the policy allows it', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      { showPinnedWorktreesInGroups: true } as never,
      [],
      new Set(),
      new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: 'wt-pinned' })
        }),
        expect.objectContaining({
          type: 'item',
          sectionKey: `repo:${repo.id}`,
          worktree: expect.objectContaining({ id: 'wt-pinned' })
        })
      ])
    )
  })

  it('suppresses duplicate-mode imported fallback only when a natural anchor renders', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const imported = new Map([[repo.id, { repo, hiddenWorktrees: [makeDetectedWorktree()] }]])
    const expanded = buildRows(
      'none',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      { showPinnedWorktreesInGroups: true } as never,
      [],
      new Set(),
      imported
    )
    const collapsedAll = buildRows(
      'none',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(['all']),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      { showPinnedWorktreesInGroups: true } as never,
      [],
      new Set(),
      imported
    )

    expect(expanded.some((row) => row.type === 'imported-worktrees-card')).toBe(false)
    expect(collapsedAll).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'imported-worktrees-card', placement: 'pinned-fallback' })
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
      { type: 'imported-worktrees-card', placement: 'repo-group' }
    ])
    expect(
      rows.filter((row) => row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY)
    ).toEqual([])
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
      repo: folderRepo
    })
    expect(rows[1]).toMatchObject({ type: 'item', worktree: { id: folderWorktree.id } })
  })

  it('emits assigned workspace statuses as sections in groupBy workspace-status', () => {
    const review = { ...worktree, id: 'wt-review', workspaceStatus: 'in-review' as const }
    const rows = buildRows('workspace-status', [review], repoMap, null, new Set())

    expect(
      rows.filter((r) => r.type === 'header').map((r) => ({ key: r.key, label: r.label }))
    ).toEqual([{ key: 'workspace-status:in-review', label: 'In review' }])
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
      rows.filter((r) => r.type === 'header').map((r) => ({ key: r.key, label: r.label }))
    ).toEqual([
      { key: 'workspace-status:blocked', label: 'Blocked' },
      { key: 'workspace-status:in-progress', label: 'Doing' }
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
        projectGroup: group
      })
    ])
  })

  it('renders grouped repos before their visible worktrees are loaded', () => {
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
      key: 'project-group:group-1'
    })
    expect(rows[1]).toMatchObject({
      type: 'header',
      key: 'repo:repo-1',
      projectGroupDepth: 1
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
    expect(rows[0]).toMatchObject({ label: 'Platform' })
  })

  it('keeps sleep-filtered Project Group members as empty project headers', () => {
    // Why: #8865 — Hide sleeping removes workspace cards; membership placeholders
    // must still project the grouped project header so the group count stays honest.
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
    const sleepingRepo: Repo = {
      ...repo,
      id: 'repo-sleeping',
      displayName: 'sleeping-project',
      projectGroupId: group.id
    }
    const awakeRepo: Repo = {
      ...repo,
      id: 'repo-awake',
      displayName: 'awake-project',
      projectGroupId: group.id
    }
    const awakeWorktree: Worktree = {
      ...worktree,
      id: 'wt-awake',
      repoId: awakeRepo.id,
      path: '/tmp/awake'
    }

    const rows = buildRows(
      'repo',
      [awakeWorktree],
      new Map([
        [sleepingRepo.id, sleepingRepo],
        [awakeRepo.id, awakeRepo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[awakeWorktree.id, awakeWorktree]]),
      false,
      undefined,
      [group],
      new Set([sleepingRepo.id])
    )

    expect(rows[0]).toMatchObject({
      type: 'header',
      key: 'project-group:group-1',
      count: 2
    })
    // Why: empty/placeholder projects sort after projects with visible activity.
    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-1',
      `repo:${awakeRepo.id}`,
      `repo:${sleepingRepo.id}`
    ])
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

  it('renders repos whose Project Group metadata is missing as top-level repo rows', () => {
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
    const repoWithMissingGroup: Repo = { ...repo, projectGroupId: 'missing-group' }

    const rows = buildRows(
      'repo',
      [worktree],
      new Map([[repoWithMissingGroup.id, repoWithMissingGroup]]),
      null,
      new Set(),
      new Map([[repoWithMissingGroup.id, 0]]),
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
    expect(rows.find((row) => row.type === 'header' && row.key === 'repo:repo-1')).toMatchObject({
      projectGroupDepth: 0
    })
  })

  it('does not render collapsed child-group repos as missing metadata fallbacks', () => {
    const parentGroup: ProjectGroup = {
      id: 'parent-group',
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
    const childGroup: ProjectGroup = {
      ...parentGroup,
      id: 'child-group',
      name: 'Services',
      parentPath: '/platform/services',
      parentGroupId: parentGroup.id
    }
    const repoInChildGroup: Repo = { ...repo, projectGroupId: childGroup.id }

    const rows = buildRows(
      'repo',
      [worktree],
      new Map([[repoInChildGroup.id, repoInChildGroup]]),
      null,
      new Set(['project-group:parent-group']),
      new Map([[repoInChildGroup.id, 0]]),
      undefined,
      'manual',
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [parentGroup, childGroup]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:parent-group'
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

  it('falls back to repoOrder for grouped repos missing projectGroupOrder in manual mode', () => {
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
    const repoA: Repo = { ...repo, id: 'repo-a', displayName: 'alpha', projectGroupId: group.id }
    const repoB: Repo = { ...repo, id: 'repo-b', displayName: 'beta', projectGroupId: group.id }
    const repoC: Repo = { ...repo, id: 'repo-c', displayName: 'gamma', projectGroupId: group.id }
    const groupedMap = new Map([
      [repoA.id, repoA],
      [repoB.id, repoB],
      [repoC.id, repoC]
    ])
    const repoOrder = new Map([
      [repoA.id, 0],
      [repoB.id, 1],
      [repoC.id, 2]
    ])

    const rows = buildRows(
      'repo',
      [
        { ...worktree, id: 'wt-a', repoId: repoA.id },
        { ...worktree, id: 'wt-b', repoId: repoB.id },
        { ...worktree, id: 'wt-c', repoId: repoC.id }
      ],
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
      'repo:repo-a',
      'repo:repo-b',
      'repo:repo-c'
    ])
  })

  it('sorts a dragged project between repo-order fallbacks inside a group', () => {
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
    const repoA: Repo = { ...repo, id: 'repo-a', displayName: 'alpha', projectGroupId: group.id }
    const repoB: Repo = { ...repo, id: 'repo-b', displayName: 'beta', projectGroupId: group.id }
    const repoC: Repo = {
      ...repo,
      id: 'repo-c',
      displayName: 'gamma',
      projectGroupId: group.id,
      projectGroupOrder: 500
    }
    const groupedMap = new Map([
      [repoA.id, repoA],
      [repoB.id, repoB],
      [repoC.id, repoC]
    ])
    const repoOrder = new Map([
      [repoA.id, 0],
      [repoB.id, 1],
      [repoC.id, 2]
    ])

    const rows = buildRows(
      'repo',
      [
        { ...worktree, id: 'wt-a', repoId: repoA.id },
        { ...worktree, id: 'wt-b', repoId: repoB.id },
        { ...worktree, id: 'wt-c', repoId: repoC.id }
      ],
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
      'repo:repo-a',
      'repo:repo-c',
      'repo:repo-b'
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

  it('orders Project Group siblings by tabOrder within each parent bucket', () => {
    const rootA: ProjectGroup = {
      id: 'group-root-a',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 20,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const rootB: ProjectGroup = {
      ...rootA,
      id: 'group-root-b',
      name: 'Infrastructure',
      tabOrder: 10
    }
    const childLate: ProjectGroup = {
      ...rootA,
      id: 'group-child-late',
      name: 'late',
      parentGroupId: rootB.id,
      tabOrder: 30
    }
    const childEarly: ProjectGroup = {
      ...rootA,
      id: 'group-child-early',
      name: 'early',
      parentGroupId: rootB.id,
      tabOrder: 5
    }

    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      'recent',
      {},
      undefined,
      false,
      undefined,
      [rootA, rootB, childLate, childEarly]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-root-b',
      'project-group:group-child-early',
      'project-group:group-child-late',
      'project-group:group-root-a'
    ])
    expect(rows.filter((row) => row.type === 'header').map((row) => row.projectGroupDepth)).toEqual(
      [0, 1, 1, 0]
    )
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
    expect(rows.filter((row) => row.type === 'header').map((row) => row.projectGroupDepth)).toEqual(
      [0, 1, 2, 3, 3]
    )
  })

  it('returns both parent Project Group and repo keys for grouped repo reveals', () => {
    const groupedRepo: Repo = { ...repo, projectGroupId: 'group-1' }
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

    expect(
      getGroupKeysForWorktree(
        'repo',
        worktree,
        new Map([[groupedRepo.id, groupedRepo]]),
        null,
        undefined,
        undefined,
        [group]
      )
    ).toEqual(['project-group:group-1', 'repo:repo-1'])
  })

  it('returns only the repo key for missing Project Group metadata reveals', () => {
    const groupedRepo: Repo = { ...repo, projectGroupId: 'missing-group' }
    const loadedGroup: ProjectGroup = {
      id: 'loaded-group',
      name: 'Loaded',
      parentPath: '/loaded',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }

    expect(
      getGroupKeysForWorktree(
        'repo',
        worktree,
        new Map([[groupedRepo.id, groupedRepo]]),
        null,
        undefined,
        undefined,
        [loadedGroup]
      )
    ).toEqual(['repo:repo-1'])
  })

  it('returns only the repo key for ungrouped repo reveals', () => {
    expect(getGroupKeysForWorktree('repo', worktree, repoMap, null)).toEqual(['repo:repo-1'])
  })
})

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
    const source = readWorktreeListSource()

    expect(source).not.toContain('leading-none capitalize')
  })

  it('collapses repo header actions without reserving title width', () => {
    expect(REPO_HEADER_ACTION_REVEAL_CLASS).toContain('min-w-0 max-w-0 -ml-1.5')
    expect(REPO_HEADER_ACTION_REVEAL_CLASS).toContain('focus:ml-0 focus:max-w-5 focus:opacity-100')
    expect(REPO_HEADER_ACTION_REVEAL_CLASS).toContain(
      'group-hover:ml-0 group-hover:max-w-5 group-hover:opacity-100'
    )
    expect(REPO_HEADER_ACTION_BUTTON_CLASS).toContain(
      'transition-[margin,max-width,opacity,background-color,color]'
    )
    expect(REPO_HEADER_ACTION_BUTTON_CLASS).toContain(
      'data-[state=open]:ml-0 data-[state=open]:max-w-5 data-[state=open]:opacity-100'
    )
  })

  it('resolves repo header color from project group headers only', () => {
    const source = readWorktreeListSource()

    expect(source).toContain('resolveProjectGroupHeaderColor({')
    expect(source).toContain('headerKey: row.key')
    expect(source).toContain('color={repoHeaderColor}')
  })

  it('adapts projected setup rows for sidebar project grouping', () => {
    const source = readWorktreeListSource()

    expect(source).toContain('const projectHostSetupProjection = useProjectHostSetupProjection()')
    expect(source).toContain('projectHostSetups: projectHostSetupProjection.setups')
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
      new Map(),
      [makePendingCreation('c1', repo.id)]
    )

    expect(rows[0]).toMatchObject({ type: 'pending-creation', creationId: 'c1' })
  })
})
