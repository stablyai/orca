import { describe, expect, it } from 'vitest'
import type { Repo } from '../repo-types'
import type { DetectedWorktree } from '../worktree/types'
import { appendImportedWorktreeLines } from './imported-worktree-lines'
import type { ImportedWorktreesCardCandidate, Row } from './row-types'

const local: Repo = {
  id: 'repo-a',
  displayName: 'alpha',
  path: '/a',
  badgeColor: '#000',
  addedAt: 0
}
const localTwo: Repo = { ...local, id: 'repo-b', displayName: 'beta', path: '/b' }
const remote: Repo = { ...local, id: 'repo-c', path: '/c', executionHostId: 'runtime:env-1' }

function candidate(repo: Repo): ImportedWorktreesCardCandidate {
  const hidden: DetectedWorktree = {
    id: `hidden-${repo.id}`,
    repoId: repo.id,
    path: `/wt/${repo.id}`,
    branch: 'refs/heads/hidden',
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
    displayName: 'hidden',
    sortOrder: 0,
    lastActivityAt: 0,
    visible: false,
    selectedCheckout: false,
    ownership: 'external'
  }
  return { repo, hiddenWorktrees: [hidden] }
}

function append(repos: Repo[]): Row[] {
  return appendImportedWorktreeLines([], {
    importedWorktreesByRepo: new Map(repos.map((repo) => [repo.id, candidate(repo)])),
    defaultHostId: 'local',
    hostLabelById: new Map([['runtime:env-1', 'Build box']])
  })
}

describe('appendImportedWorktreeLines', () => {
  it('covers every project on a host with one unlabelled line', () => {
    expect(append([local, localTwo])).toMatchObject([
      {
        placement: 'all-projects',
        hostId: 'local',
        projects: [{ repo: { id: 'repo-a' } }, { repo: { id: 'repo-b' } }]
      }
    ])
    expect(append([local, localTwo])[0]).not.toHaveProperty('hostContextLabel')
  })

  it('gives each host its own line, named, when projects span hosts', () => {
    expect(append([local, remote])).toMatchObject([
      { hostId: 'local', hostContextHostId: 'local', projects: [{ repo: { id: 'repo-a' } }] },
      {
        hostId: 'runtime:env-1',
        hostContextLabel: 'Build box',
        projects: [{ repo: { id: 'repo-c' } }]
      }
    ])
  })
})
