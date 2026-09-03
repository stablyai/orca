import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { canAssignWorktreeParent } from './worktree-parent-eligibility'
import { getEligibleWorktreeParents, isEligibleWorktreeParent } from './worktree-parent-candidates'

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

function makeRepoOwners(
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[] = [
    { id: 'repo', connectionId: null, executionHostId: 'local' }
  ]
): Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>[]> {
  const owners = new Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>[]>()
  for (const repo of repos) {
    owners.set(repo.id, [...(owners.get(repo.id) ?? []), repo])
  }
  return owners
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

  it('offers a cross-repo candidate on the same host to the picker', () => {
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
        repoOwners: makeRepoOwners([
          { id: 'repo-a', connectionId: null, executionHostId: 'local' },
          { id: 'repo-b', connectionId: null, executionHostId: 'local' }
        ])
      }).map((worktree) => worktree.id)
    ).toEqual([sameRepo.id, otherRepo.id])
  })

  it('excludes a cross-repo candidate whose repo runs on another host', () => {
    const child = makeWorktree('child', 'repo-a')
    const otherRepo = makeWorktree('other-repo', 'repo-b')
    const worktrees = [child, otherRepo]

    expect(
      getEligibleWorktreeParents({
        child,
        worktrees,
        lineageById: {},
        worktreeMap: makeMap(worktrees),
        repoOwners: makeRepoOwners([
          { id: 'repo-a', connectionId: null, executionHostId: 'local' },
          { id: 'repo-b', connectionId: null, executionHostId: 'ssh:remote' }
        ])
      })
    ).toEqual([])
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
        repoOwners: makeRepoOwners([
          { id: 'repo-a', connectionId: null, executionHostId: 'runtime:env-a' }
        ])
      }).map((worktree) => worktree.id)
    ).toEqual([sameHost.id])
  })

  it('fails closed for unstamped worktrees with duplicate repo owners', () => {
    const child = makeWorktree('child', 'repo-a')
    const candidate = makeWorktree('candidate', 'repo-b')
    const worktrees = [child, candidate]
    const repoOwners = makeRepoOwners([
      { id: 'repo-a', connectionId: null, executionHostId: 'local' },
      { id: 'repo-a', connectionId: null, executionHostId: 'runtime:env-a' },
      { id: 'repo-b', connectionId: null, executionHostId: 'local' },
      { id: 'repo-b', connectionId: null, executionHostId: 'runtime:env-b' }
    ])

    candidate.hostId = 'local'
    expect(
      getEligibleWorktreeParents({
        child,
        worktrees,
        lineageById: {},
        worktreeMap: makeMap(worktrees),
        repoOwners
      })
    ).toEqual([])

    child.hostId = 'local'
    candidate.hostId = undefined
    expect(
      getEligibleWorktreeParents({
        child,
        worktrees,
        lineageById: {},
        worktreeMap: makeMap(worktrees),
        repoOwners
      })
    ).toEqual([])

    candidate.hostId = 'local'
    expect(
      getEligibleWorktreeParents({
        child,
        worktrees,
        lineageById: {},
        worktreeMap: makeMap(worktrees),
        repoOwners
      })
    ).toEqual([candidate])
  })

  it('offers a candidate across a known project boundary for picker and direct drop checks', () => {
    const child = { ...makeWorktree('child'), projectId: 'project-a' }
    const sameProject = { ...makeWorktree('same-project'), projectId: 'project-a' }
    const otherProject = { ...makeWorktree('other-project'), projectId: 'project-b' }
    const worktrees = [child, sameProject, otherProject]
    const worktreeMap = makeMap(worktrees)
    const repoOwners = makeRepoOwners()

    expect(
      getEligibleWorktreeParents({
        child,
        worktrees,
        lineageById: {},
        worktreeMap,
        repoOwners
      }).map((worktree) => worktree.id)
    ).toEqual([sameProject.id, otherProject.id])
    expect(
      isEligibleWorktreeParent({
        child,
        candidateParent: otherProject,
        lineageById: {},
        worktreeMap,
        repoOwners
      })
    ).toBe(true)
  })

  it('excludes a candidate across a known host boundary for picker and direct drop checks', () => {
    const child = { ...makeWorktree('child'), hostId: 'local' as const }
    const otherHost = { ...makeWorktree('other-host'), hostId: 'ssh:remote' as const }
    const worktrees = [child, otherHost]
    const worktreeMap = makeMap(worktrees)
    const repoOwners = makeRepoOwners()

    expect(
      getEligibleWorktreeParents({
        child,
        worktrees,
        lineageById: {},
        worktreeMap,
        repoOwners
      })
    ).toEqual([])
    expect(
      isEligibleWorktreeParent({
        child,
        candidateParent: otherHost,
        lineageById: {},
        worktreeMap,
        repoOwners
      })
    ).toBe(false)
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
        repoOwners: makeRepoOwners()
      }).map((worktree) => worktree.id)
    ).toEqual([visible.id])
  })
})
