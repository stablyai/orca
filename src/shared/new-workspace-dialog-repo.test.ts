import { describe, expect, it } from 'vitest'
import type { Repo } from './repo-types'
import {
  getNewWorkspaceDialogEligibleRepos,
  resolveNewWorkspaceDialogGitRepoId,
  resolveNewWorkspaceDialogRepoId
} from './new-workspace-dialog-repo'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

describe('new workspace dialog repo selection', () => {
  it('returns null for create-base prefetch when the dialog default is a folder repo', () => {
    const eligibleRepos = [makeRepo('folder', { kind: 'folder' }), makeRepo('git')]

    expect(resolveNewWorkspaceDialogGitRepoId({ eligibleRepos })).toBeNull()
  })

  it('excludes runtime-owned (per-workspace-env) SSH repos but keeps user SSH repos', () => {
    const eligible = getNewWorkspaceDialogEligibleRepos([
      makeRepo('local-repo'),
      makeRepo('user-ssh', { connectionId: 'my-server' }),
      makeRepo('runtime-ssh', { connectionId: 'runtime-ssh-orca-1' })
    ])

    expect(eligible.map((repo) => repo.id)).toEqual(['local-repo', 'user-ssh'])
  })

  it('defaults to a repo on the focused host when no explicit repo is chosen', () => {
    const eligibleRepos = [
      makeRepo('local-repo'),
      makeRepo('ssh-repo', { connectionId: 'win-vm' }),
      makeRepo('runtime-repo', { executionHostId: 'runtime:env-1' })
    ]

    expect(resolveNewWorkspaceDialogRepoId({ eligibleRepos, focusedHostScope: 'ssh:win-vm' })).toBe(
      'ssh-repo'
    )
    expect(
      resolveNewWorkspaceDialogRepoId({ eligibleRepos, focusedHostScope: 'runtime:env-1' })
    ).toBe('runtime-repo')
    expect(resolveNewWorkspaceDialogRepoId({ eligibleRepos, focusedHostScope: 'local' })).toBe(
      'local-repo'
    )
  })

  it('lets explicit draft/initial/active choices win over the focused host', () => {
    const eligibleRepos = [makeRepo('local-repo'), makeRepo('ssh-repo', { connectionId: 'win-vm' })]

    expect(
      resolveNewWorkspaceDialogRepoId({
        eligibleRepos,
        activeRepoId: 'local-repo',
        focusedHostScope: 'ssh:win-vm'
      })
    ).toBe('local-repo')
  })
})
