import { describe, expect, it } from 'vitest'
import { paletteResultQualityClassRank } from './palette-match/match-quality'
import { searchWorktrees } from './worktree-palette-search'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-registry',
    path: '/work/Registry',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'displayName'>): Repo {
  return { path: `/work/${overrides.displayName}`, badgeColor: '#22c55e', addedAt: 0, ...overrides }
}

// The project is shown as "Registry"; its remote is lab-team/vault-registry.
const registry = makeRepo({
  id: 'repo-registry',
  displayName: 'Registry',
  gitRemoteIdentity: {
    canonicalKey: 'github.com/lab-team/vault-registry',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:lab-team/vault-registry.git'
  }
})
const notes = makeRepo({
  id: 'repo-notes',
  displayName: 'Notes',
  gitRemoteIdentity: {
    canonicalKey: 'gitlab.com/someone/papers/notes',
    remoteName: 'origin',
    remoteUrl: 'https://gitlab.com/someone/papers/notes.git'
  }
})
const repoMap = new Map<string, Repo>([
  [registry.id, registry],
  [notes.id, notes]
])

const registryMain = makeWorktree()
const registryFeature = makeWorktree({
  id: 'wt-2',
  path: '/work/Registry-archive',
  branch: 'refs/heads/archive-design',
  isMainWorktree: false,
  displayName: 'archive design'
})
const notesMain = makeWorktree({ id: 'wt-3', repoId: 'repo-notes', path: '/work/Notes' })

describe('worktree palette search by remote repository name', () => {
  it('finds a workspace by the repository name its project is not displayed under', () => {
    const results = searchWorktrees([registryMain], 'vault-registry', repoMap)

    expect(results).toHaveLength(1)
    expect(results[0]?.matchedFields).toEqual(['repository'])
    expect(results[0]?.supportingText).toMatchObject({
      labelKind: 'repository',
      text: 'lab-team/vault-registry'
    })
  })

  it('finds every workspace of one repository by its owner, and no other', () => {
    const results = searchWorktrees([registryMain, registryFeature, notesMain], 'lab-team', repoMap)

    expect(results.map((result) => result.worktreeId).sort()).toEqual(['wt-1', 'wt-2'])
  })

  it('finds a workspace under a nested remote path of another provider', () => {
    const results = searchWorktrees([registryMain, notesMain], 'papers', repoMap)

    expect(results.map((result) => result.worktreeId)).toEqual(['wt-3'])
    expect(results[0]?.supportingText?.text).toBe('someone/papers/notes')
  })

  it('ranks a workspace named like the query above one that only shares the owner', () => {
    const named = makeWorktree({ id: 'wt-4', repoId: 'repo-notes', displayName: 'lab-team' })

    const classById = new Map(
      searchWorktrees([registryMain, named], 'lab-team', repoMap).map((result) => [
        result.worktreeId,
        result.qualityClass
      ])
    )
    const nameClass = classById.get('wt-4')
    const ownerClass = classById.get('wt-1')

    expect(nameClass).toBeTruthy()
    expect(ownerClass).toBeTruthy()
    if (nameClass && ownerClass) {
      expect(paletteResultQualityClassRank(nameClass)).toBeLessThan(
        paletteResultQualityClassRank(ownerClass)
      )
    }
  })

  it('still shows a comment that matches as well as the repository name does', () => {
    const commented = makeWorktree({ comment: 'lab-team/vault-registry' })

    const results = searchWorktrees([commented], 'lab-team/vault-registry', repoMap)

    expect(results[0]?.supportingText?.labelKind).toBe('comment')
  })

  it('lets the displayed project name explain the match when it already does', () => {
    const results = searchWorktrees([registryMain], 'Registry', repoMap)

    expect(results).toHaveLength(1)
    expect(results[0]?.matchedFields).toContain('repo')
  })

  it('finds nothing for a project with no remote', () => {
    const local = makeRepo({ id: 'repo-registry', displayName: 'Registry' })

    expect(searchWorktrees([registryMain], 'vault', new Map([[local.id, local]]))).toEqual([])
  })

  it('does not filter board cards by a name they do not print', () => {
    const results = searchWorktrees([registryMain], 'vault-registry', repoMap, {
      evidencePolicy: 'board'
    })

    expect(results).toEqual([])
  })
})
