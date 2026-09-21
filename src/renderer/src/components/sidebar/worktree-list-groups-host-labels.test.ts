import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import { getGroupKeyForWorktree } from './worktree-list/grouping/worktree-group-keys'
import {
  LOCAL_HOST_LABEL,
  repo,
  worktree,
  remoteRepo,
  remoteWorktree,
  project,
  projectHostSetups
} from './worktree-list-groups-test-fixtures'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

describe('buildRows with pinned worktrees', () => {
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

  it('uses the registered SSH target label for openclaw rows', () => {
    const sshRepo: Repo = {
      ...remoteRepo,
      id: 'repo-openclaw',
      connectionId: 'openclaw',
      executionHostId: 'ssh:openclaw'
    }
    const sshWorktree: Worktree = {
      ...remoteWorktree,
      id: 'wt-openclaw',
      repoId: sshRepo.id
    }
    const rows = buildRows(
      'workspace-status',
      [worktree, sshWorktree],
      new Map([
        [repo.id, repo],
        [sshRepo.id, sshRepo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([
        [worktree.id, worktree],
        [sshWorktree.id, sshWorktree]
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
      new Map([['ssh:openclaw', 'openclaw']])
    )

    expect(rows.filter((row) => row.type === 'item')).toMatchObject([
      { worktree: { id: worktree.id }, hostContextLabel: LOCAL_HOST_LABEL },
      { worktree: { id: sshWorktree.id }, hostContextLabel: 'openclaw' }
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
})
