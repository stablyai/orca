import { describe, expect, it } from 'vitest'
import type { Repo } from './types'
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
  it('matches the dialog repo priority order', () => {
    const eligibleRepos = [
      makeRepo('first'),
      makeRepo('active'),
      makeRepo('initial'),
      makeRepo('draft')
    ]

    expect(
      resolveNewWorkspaceDialogRepoId({
        eligibleRepos,
        draftRepoId: 'draft',
        initialRepoId: 'initial',
        activeRepoId: 'active'
      })
    ).toBe('draft')
  })

  it('falls back through initial, active, then first eligible repo', () => {
    const eligibleRepos = [makeRepo('first'), makeRepo('active')]

    expect(resolveNewWorkspaceDialogRepoId({ eligibleRepos, initialRepoId: 'missing' })).toBe(
      'first'
    )
    expect(resolveNewWorkspaceDialogRepoId({ eligibleRepos, activeRepoId: 'active' })).toBe(
      'active'
    )
  })

  it('returns null for create-base prefetch when the dialog default is a folder repo', () => {
    const eligibleRepos = [makeRepo('folder', { kind: 'folder' }), makeRepo('git')]

    expect(resolveNewWorkspaceDialogGitRepoId({ eligibleRepos })).toBeNull()
  })

  it('excludes repos without paths from dialog defaults', () => {
    expect(
      getNewWorkspaceDialogEligibleRepos([makeRepo('missing-path', { path: '' }), makeRepo('repo')])
    ).toEqual([expect.objectContaining({ id: 'repo' })])
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

  it('ignores host scope "all" and falls back to the first eligible repo', () => {
    const eligibleRepos = [makeRepo('local-repo'), makeRepo('ssh-repo', { connectionId: 'win-vm' })]

    expect(resolveNewWorkspaceDialogRepoId({ eligibleRepos, focusedHostScope: 'all' })).toBe(
      'local-repo'
    )
  })
})
