import { describe, expect, it } from 'vitest'

import { buildRows } from './build-rows.test-fixture'

import { repo, worktree, project, projectHostSetups } from './worktree-list-groups-test-fixtures'
import type { ProjectHostSetup } from '../../../../../../shared/project-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

describe('buildRows with pinned worktrees', () => {
  it('splits duplicate user checkouts while a provisioned copy nests, on one host', () => {
    // Exercise real-checkout splitting and provisioned-copy nesting together on one host.
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
        settings: { projectGroupingMode: 'folder' },
        projectHostSetups: [projectHostSetups[0]!, localSetupB, runtimeSetupB]
      }
    )

    const headers = rows.filter((row) => row.type === 'header')
    expect(headers.map((row) => row.key).sort()).toEqual([
      'project:github:stablyai/orca::host:local::local::default',
      'project:github:stablyai/orca::host:local::local::default::setup:repo-1',
      'project:github:stablyai/orca::host:local::local::default::setup:repo-local-b'
    ])
    // Only real checkouts receive setup-scoped headers; provisioned copies retain the project label.
    expect(
      headers.some(
        (row) =>
          row.key ===
          'project:github:stablyai/orca::host:local::local::default::setup:repo-runtime-b'
      )
    ).toBe(false)
    expect(
      headers.find((row) => row.key === 'project:github:stablyai/orca::host:local::local::default')
    ).toMatchObject({
      label: 'Orca',
      count: 1
    })
  })
})
