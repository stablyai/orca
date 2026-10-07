import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildWorktreeLineageTreeGraph,
  findRootLineageAncestorId
} from './worktree-lineage-tree-model'

function makeWorktree(id: string, repoId: string, branch: string): Worktree {
  return {
    id,
    repoId,
    displayName: branch,
    branch,
    head: 'abc123',
    isBare: false,
    path: `/path/${repoId}/${branch}`,
    instanceId: `inst-${id}`,
    isMainWorktree: false,
    createdAt: 1000,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isPinned: false,
    sortOrder: 0,
    isUnread: false,
    lastActivityAt: 1000
  }
}

function makeRepo(id: string, name: string): Repo {
  return {
    id,
    displayName: name,
    path: `/repos/${id}`,
    badgeColor: '#10b981',
    addedAt: 1000
  }
}

describe('worktree-lineage-tree-model', () => {
  const repo1 = makeRepo('repo-1', 'loan-core')
  const repo2 = makeRepo('repo-2', 'loans.database-core')
  const repo3 = makeRepo('repo-3', 'loans.analytics-core')

  const wt1 = makeWorktree('wt-1', 'repo-1', 'feature/parent')
  const wt2 = makeWorktree('wt-2', 'repo-2', 'feature/child')
  const wt3 = makeWorktree('wt-3', 'repo-3', 'feature/grandchild')
  const wt4 = makeWorktree('wt-4', 'repo-2', 'feature/sibling')

  const worktreeMap = new Map([
    [wt1.id, wt1],
    [wt2.id, wt2],
    [wt3.id, wt3],
    [wt4.id, wt4]
  ])

  const repoMap = new Map([
    [repo1.id, repo1],
    [repo2.id, repo2],
    [repo3.id, repo3]
  ])

  const lineageById: Record<string, WorktreeLineage> = {
    'wt-2': {
      worktreeId: 'wt-2',
      parentWorktreeId: 'wt-1',
      worktreeInstanceId: 'inst-wt-2',
      parentWorktreeInstanceId: 'inst-wt-1',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    },
    'wt-3': {
      worktreeId: 'wt-3',
      parentWorktreeId: 'wt-2',
      worktreeInstanceId: 'inst-wt-3',
      parentWorktreeInstanceId: 'inst-wt-2',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    },
    'wt-4': {
      worktreeId: 'wt-4',
      parentWorktreeId: 'wt-1',
      worktreeInstanceId: 'inst-wt-4',
      parentWorktreeInstanceId: 'inst-wt-1',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
  }

  it('finds root ancestor for child and grandchild', () => {
    expect(findRootLineageAncestorId('wt-3', lineageById, worktreeMap)).toBe('wt-1')
    expect(findRootLineageAncestorId('wt-2', lineageById, worktreeMap)).toBe('wt-1')
    expect(findRootLineageAncestorId('wt-1', lineageById, worktreeMap)).toBe('wt-1')
  })

  it('builds full hierarchy tree graph from grandchild target', () => {
    const graph = buildWorktreeLineageTreeGraph({
      targetWorktreeId: 'wt-3',
      newlyLinkedId: 'wt-3',
      lineageById,
      worktreeMap,
      repoMap
    })

    expect(graph.rootNode).not.toBeNull()
    expect(graph.rootNode?.worktree.id).toBe('wt-1')
    expect(graph.rootNode?.depth).toBe(0)
    expect(graph.rootNode?.isRoot).toBe(true)
    expect(graph.rootNode?.children.length).toBe(2)
    expect(graph.totalNodes).toBe(4)

    expect(graph.targetNode?.worktree.id).toBe('wt-3')
    expect(graph.targetNode?.isTarget).toBe(true)
    expect(graph.newlyLinkedNode?.worktree.id).toBe('wt-3')
    expect(graph.newlyLinkedNode?.isNewlyLinked).toBe(true)

    const childWt2 = graph.rootNode?.children.find((c) => c.worktree.id === 'wt-2')
    expect(childWt2?.depth).toBe(1)
    expect(childWt2?.children.length).toBe(1)
    expect(childWt2?.children[0].worktree.id).toBe('wt-3')
    expect(childWt2?.children[0].depth).toBe(2)
  })

  it('safely handles cyclic lineage', () => {
    const cyclicLineage: Record<string, WorktreeLineage> = {
      'wt-1': {
        worktreeId: 'wt-1',
        parentWorktreeId: 'wt-2',
        worktreeInstanceId: 'inst-wt-1',
        parentWorktreeInstanceId: 'inst-wt-2',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      },
      'wt-2': {
        worktreeId: 'wt-2',
        parentWorktreeId: 'wt-1',
        worktreeInstanceId: 'inst-wt-2',
        parentWorktreeInstanceId: 'inst-wt-1',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }

    const graph = buildWorktreeLineageTreeGraph({
      targetWorktreeId: 'wt-1',
      lineageById: cyclicLineage,
      worktreeMap,
      repoMap
    })

    expect(graph.rootNode).not.toBeNull()
    expect(graph.totalNodes).toBeLessThanOrEqual(2)
  })
})
