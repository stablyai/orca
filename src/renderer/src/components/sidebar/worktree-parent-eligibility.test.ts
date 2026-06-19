import { describe, expect, it } from 'vitest'
import { join } from 'path'
import type { Repo, Worktree, WorktreeLineage } from '../../../../shared/types'
import { canAssignWorktreeParent } from './worktree-parent-eligibility'
import { getEligibleWorktreeParents } from './worktree-parent-candidates'

function makeWorktree(id: string, repoId = 'repo'): Worktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId,
    path: join('/workspaces', id),
    head: `${id}-head`,
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
    isSparse: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

function makeMap(worktrees: readonly Worktree[]): Map<string, Worktree> {
  return new Map(worktrees.map((worktree) => [worktree.id, worktree]))
}

function makeRepoMap(
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[] = [
    { id: 'repo', connectionId: null, executionHostId: 'local' }
  ]
): Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>> {
  return new Map(repos.map((repo) => [repo.id, repo]))
}

describe('canAssignWorktreeParent', () => {
  it('excludes self, valid current parent, and descendants', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const grandchild = makeWorktree('grandchild')
    const sibling = makeWorktree('sibling')
    const worktrees = [parent, child, grandchild, sibling]
    const lineageById = {
      [child.id]: makeLineage(child, parent),
      [grandchild.id]: makeLineage(grandchild, child)
    }

    expect(
      canAssignWorktreeParent({
        child,
        candidateParent: child,
        lineageById,
        worktreeMap: makeMap(worktrees)
      })
    ).toBe(false)
    expect(
      canAssignWorktreeParent({
        child,
        candidateParent: parent,
        lineageById,
        worktreeMap: makeMap(worktrees)
      })
    ).toBe(false)
    expect(
      canAssignWorktreeParent({
        child,
        candidateParent: grandchild,
        lineageById,
        worktreeMap: makeMap(worktrees)
      })
    ).toBe(false)
    expect(
      canAssignWorktreeParent({
        child,
        candidateParent: sibling,
        lineageById,
        worktreeMap: makeMap(worktrees)
      })
    ).toBe(true)
  })

  it('treats stale instance edges as broken during descendant traversal', () => {
    const child = makeWorktree('child')
    const descendant = makeWorktree('descendant')
    const staleParent = makeWorktree('stale-parent')
    const lineageById = {
      [descendant.id]: {
        ...makeLineage(descendant, child),
        parentWorktreeInstanceId: 'old-child-instance'
      },
      [staleParent.id]: makeLineage(staleParent, descendant)
    }

    expect(
      canAssignWorktreeParent({
        child,
        candidateParent: staleParent,
        lineageById,
        worktreeMap: makeMap([child, descendant, staleParent])
      })
    ).toBe(true)
  })

  it('allows a raw current parent candidate when the child lineage is stale', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const lineageById = {
      [child.id]: {
        ...makeLineage(child, parent),
        parentWorktreeInstanceId: 'old-parent-instance'
      }
    }

    expect(
      canAssignWorktreeParent({
        child,
        candidateParent: parent,
        lineageById,
        worktreeMap: makeMap([parent, child])
      })
    ).toBe(true)
  })

  it('rejects candidates inside pre-existing lineage loops', () => {
    const child = makeWorktree('child')
    const firstLoopParent = makeWorktree('first-loop-parent')
    const secondLoopParent = makeWorktree('second-loop-parent')
    const lineageById = {
      [firstLoopParent.id]: makeLineage(firstLoopParent, secondLoopParent),
      [secondLoopParent.id]: makeLineage(secondLoopParent, firstLoopParent)
    }

    expect(
      canAssignWorktreeParent({
        child,
        candidateParent: firstLoopParent,
        lineageById,
        worktreeMap: makeMap([child, firstLoopParent, secondLoopParent])
      })
    ).toBe(false)
  })

  it('stays repo-agnostic while the picker candidate filter is repo and host scoped', () => {
    const child = makeWorktree('child', 'repo-a')
    const sameRepo = makeWorktree('same-repo', 'repo-a')
    const otherRepo = makeWorktree('other-repo', 'repo-b')
    const worktrees = [child, sameRepo, otherRepo]

    expect(
      canAssignWorktreeParent({
        child,
        candidateParent: otherRepo,
        lineageById: {},
        worktreeMap: makeMap(worktrees)
      })
    ).toBe(true)
    expect(
      getEligibleWorktreeParents({
        child,
        worktrees,
        lineageById: {},
        worktreeMap: makeMap(worktrees),
        repoMap: makeRepoMap([
          { id: 'repo-a', connectionId: null, executionHostId: 'local' },
          { id: 'repo-b', connectionId: null, executionHostId: 'local' }
        ])
      }).map((worktree) => worktree.id)
    ).toEqual([sameRepo.id])
  })

  it('excludes same-repo candidates owned by a different runtime host', () => {
    const child = makeWorktree('child', 'repo-a')
    const sameHost = makeWorktree('same-host', 'repo-a')
    const otherHost = makeWorktree('other-host', 'repo-a')
    child.hostId = 'runtime:env-a'
    sameHost.hostId = 'runtime:env-a'
    otherHost.hostId = 'runtime:env-b'
    const worktrees = [child, sameHost, otherHost]

    expect(
      getEligibleWorktreeParents({
        child,
        worktrees,
        lineageById: {},
        worktreeMap: makeMap(worktrees),
        repoMap: makeRepoMap([
          { id: 'repo-a', connectionId: null, executionHostId: 'runtime:env-a' }
        ])
      }).map((worktree) => worktree.id)
    ).toEqual([sameHost.id])
  })

  it('excludes archived worktrees from picker candidates', () => {
    const child = makeWorktree('child')
    const archived = makeWorktree('archived')
    const visible = makeWorktree('visible')
    archived.isArchived = true

    expect(
      getEligibleWorktreeParents({
        child,
        worktrees: [child, archived, visible],
        lineageById: {},
        worktreeMap: makeMap([child, archived, visible]),
        repoMap: makeRepoMap()
      }).map((worktree) => worktree.id)
    ).toEqual([visible.id])
  })
})
