import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import {
  getComposerEligibleRepos,
  resolveComposerGitRepoId,
  resolveComposerRepoId
} from './new-workspace-composer-repo'

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

describe('new-workspace-composer-repo', () => {
  it('matches the composer repo priority order', () => {
    const eligibleRepos = [
      makeRepo('first'),
      makeRepo('active'),
      makeRepo('initial'),
      makeRepo('draft')
    ]

    expect(
      resolveComposerRepoId({
        eligibleRepos,
        draftRepoId: 'draft',
        initialRepoId: 'initial',
        activeRepoId: 'active'
      })
    ).toBe('draft')
  })

  it('falls back through initial, active, then first eligible repo', () => {
    const eligibleRepos = [makeRepo('first'), makeRepo('active')]

    expect(resolveComposerRepoId({ eligibleRepos, initialRepoId: 'missing' })).toBe('first')
    expect(resolveComposerRepoId({ eligibleRepos, activeRepoId: 'active' })).toBe('active')
  })

  it('returns null for create-base prefetch when the composer default is a folder repo', () => {
    const eligibleRepos = [makeRepo('folder', { kind: 'folder' }), makeRepo('git')]

    expect(resolveComposerGitRepoId({ eligibleRepos })).toBeNull()
  })

  it('excludes repos without paths from composer defaults', () => {
    expect(
      getComposerEligibleRepos([makeRepo('missing-path', { path: '' }), makeRepo('repo')])
    ).toEqual([expect.objectContaining({ id: 'repo' })])
  })
})
