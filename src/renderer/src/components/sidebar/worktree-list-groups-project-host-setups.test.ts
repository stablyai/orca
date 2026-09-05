import { describe, expect, it } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildRows } from './worktree-list/grouping/build-rows'
import { getGroupKeyForWorktree } from './worktree-list/grouping/worktree-group-keys'
import {
  LOCAL_HOST_LABEL,
  repo,
  worktree,
  remoteRepo,
  remoteWorktree,
  project,
  projectHostSetups,
  makeDetectedWorktree
} from './worktree-list-groups-test-fixtures'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

describe('buildRows with pinned worktrees', () => {
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

  it('keeps the cross-host project header label when another project section renders', () => {
    // Why: the project header must read the project's own display name, not the
    // anchor checkout's repo name, however many sections are visible — toggling
    // "Hide sleeping workspaces" must not rename a project (#16127).
    const otherRepo: Repo = {
      ...repo,
      id: 'repo-other',
      path: '/tmp/design-assets',
      displayName: 'design-assets'
    }
    const otherWorktree: Worktree = {
      ...worktree,
      id: 'wt-other',
      repoId: otherRepo.id,
      path: '/tmp/design-assets-feature',
      displayName: 'palette'
    }
    const buildHeaders = (extraWorktrees: Worktree[], extraRepos: Repo[]) => {
      const worktrees = [worktree, remoteWorktree, ...extraWorktrees]
      const rows = buildRows(
        'repo',
        worktrees,
        new Map([
          [repo.id, repo],
          [remoteRepo.id, remoteRepo],
          ...extraRepos.map((entry): [string, Repo] => [entry.id, entry])
        ]),
        null,
        new Set(),
        undefined,
        undefined,
        undefined,
        {},
        new Map(worktrees.map((entry) => [entry.id, entry])),
        false,
        undefined,
        [],
        new Set(),
        new Map(),
        new Map(),
        [],
        { projects: [project], projectHostSetups }
      )
      return rows.filter((row) => row.type === 'header')
    }

    expect(buildHeaders([], [])).toMatchObject([
      { key: 'project:github:stablyai/orca', label: 'Orca' }
    ])
    expect(buildHeaders([otherWorktree], [otherRepo])).toMatchObject([
      { key: 'project:github:stablyai/orca', label: 'Orca' },
      { key: 'repo:repo-other', label: 'design-assets' }
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

  it('splits only the surface with duplicate checkouts', () => {
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
      'project:github:stablyai/orca'
    ])
  })

  it('counts projection twins for one directory as one checkout', () => {
    const runtimeHostId = 'runtime:m2-air'
    const runtimeRepo: Repo = {
      ...remoteRepo,
      id: 'repo-runtime',
      path: '/home/alice/orca-runtime',
      connectionId: undefined,
      executionHostId: runtimeHostId
    }
    const runtimeWorktree: Worktree = {
      ...remoteWorktree,
      id: 'wt-runtime',
      repoId: runtimeRepo.id,
      path: '/home/alice/orca-runtime-feature'
    }
    const runtimeSetup: ProjectHostSetup = {
      ...projectHostSetups[1]!,
      id: runtimeRepo.id,
      repoId: runtimeRepo.id,
      path: runtimeRepo.path,
      hostId: runtimeHostId,
      executionHostId: runtimeHostId
    }
    const derivedSetup: ProjectHostSetup = {
      ...projectHostSetups[1]!,
      hostId: runtimeHostId,
      connectionId: 'intel mac',
      executionHostId: runtimeHostId
    }
    const authoritativeSetup: ProjectHostSetup = {
      ...derivedSetup,
      id: 'setup-authoritative',
      path: `${derivedSetup.path}/`,
      connectionId: null,
      executionHostId: 'ssh:intel%20mac'
    }
    const grouping = {
      projects: [{ ...project, sourceRepoIds: [remoteRepo.id, runtimeRepo.id] }],
      projectHostSetups: [runtimeSetup, derivedSetup, authoritativeSetup]
    }

    expect([
      getGroupKeyForWorktree(
        'repo',
        remoteWorktree,
        new Map([[remoteRepo.id, remoteRepo]]),
        null,
        undefined,
        undefined,
        grouping
      ),
      getGroupKeyForWorktree(
        'repo',
        runtimeWorktree,
        new Map([[runtimeRepo.id, runtimeRepo]]),
        null,
        undefined,
        undefined,
        grouping
      )
    ]).toEqual(['project:github:stablyai/orca', 'project:github:stablyai/orca'])
  })

  it('keeps Git hosts grouped when folder setups share the project identity', () => {
    const windowsHostId = 'runtime:windows-server'
    const windowsRepo: Repo = {
      ...repo,
      id: 'repo-windows',
      path: 'C:\\Users\\neil\\orca\\orca',
      executionHostId: windowsHostId
    }
    const folderRepoA: Repo = {
      ...repo,
      id: 'folder-qa-a',
      path: '/tmp/pr11751-folder-qa',
      displayName: 'pr11751-folder-qa',
      kind: 'folder'
    }
    const folderRepoB: Repo = {
      ...folderRepoA,
      id: 'folder-qa-b',
      path: '/tmp/pr11767-runtime-folder',
      displayName: 'pr11767-runtime-folder'
    }
    const setups: ProjectHostSetup[] = [
      projectHostSetups[0]!,
      { ...projectHostSetups[0]!, id: 'projection-twin' },
      projectHostSetups[1]!,
      {
        ...projectHostSetups[0]!,
        id: windowsRepo.id,
        repoId: windowsRepo.id,
        path: windowsRepo.path,
        hostId: windowsHostId,
        executionHostId: windowsHostId
      },
      {
        ...projectHostSetups[0]!,
        id: folderRepoA.id,
        repoId: folderRepoA.id,
        path: folderRepoA.path,
        displayName: folderRepoA.displayName,
        kind: 'folder'
      },
      {
        ...projectHostSetups[0]!,
        id: folderRepoB.id,
        repoId: folderRepoB.id,
        path: folderRepoB.path,
        displayName: folderRepoB.displayName,
        kind: 'folder'
      }
    ]
    const repos = [repo, remoteRepo, windowsRepo, folderRepoA, folderRepoB]
    const grouping = {
      projects: [{ ...project, sourceRepoIds: repos.map((entry) => entry.id) }],
      projectHostSetups: setups
    }

    const groupKeys = repos.map((entry) =>
      getGroupKeyForWorktree(
        'repo',
        { ...worktree, id: `wt-${entry.id}`, repoId: entry.id, path: entry.path },
        new Map([[entry.id, entry]]),
        null,
        undefined,
        undefined,
        grouping
      )
    )
    expect(new Set(groupKeys)).toEqual(new Set(['project:github:stablyai/orca']))
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
    // checkouts do, and that header keeps the project's own display name.
    expect(
      headers.some((row) => row.key === 'project:github:stablyai/orca::setup:repo-runtime-b')
    ).toBe(false)
    expect(headers.find((row) => row.key === 'project:github:stablyai/orca')).toMatchObject({
      label: 'Orca',
      count: 1
    })
  })
})
