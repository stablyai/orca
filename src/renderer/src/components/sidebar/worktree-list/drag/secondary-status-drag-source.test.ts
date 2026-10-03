import { describe, expect, it } from 'vitest'
import { repo, repoMap, worktree } from '../../worktree-list-groups-test-fixtures'
import { getSecondaryStatusDragSourceGroupKey } from './secondary-status-drag-source'

const STATUSES = [
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'completed', label: 'Done' }
]

function resolveSource(
  overrides: {
    sourceGroupKey?: string | null
    draggingWorktreeId?: string | null
    groupBySecondary?: 'none' | 'repo' | 'workspace-status' | 'pr-status'
    worktreeMap?: Map<string, typeof worktree>
  } = {}
) {
  return getSecondaryStatusDragSourceGroupKey({
    sourceGroupKey: overrides.sourceGroupKey ?? 'pinned',
    draggingWorktreeId: overrides.draggingWorktreeId ?? worktree.id,
    groupBy: 'repo',
    groupBySecondary: overrides.groupBySecondary ?? 'workspace-status',
    worktreeMap: overrides.worktreeMap ?? new Map([[worktree.id, worktree]]),
    repoMap,
    prCache: null,
    workspaceStatuses: STATUSES,
    settings: undefined,
    projectGroups: [],
    projectGrouping: undefined
  })
}

describe('secondary Status drag source', () => {
  it('keeps an existing nested source group unchanged', () => {
    expect(resolveSource({ sourceGroupKey: 'repo:repo-1/workspace-status:in-progress' })).toBe(
      'repo:repo-1/workspace-status:in-progress'
    )
  })

  it('maps a pinned worktree back to its Project and Status lane', () => {
    expect(resolveSource()).toBe('repo:repo-1/workspace-status:in-progress')
  })

  it('returns no temporary lane source when the pinned worktree is unavailable', () => {
    expect(resolveSource({ worktreeMap: new Map() })).toBeNull()
  })

  it('does not affect grouping modes without secondary Status', () => {
    expect(resolveSource({ groupBySecondary: 'repo' })).toBeNull()
  })

  it('preserves provider Project IDs containing slashes', () => {
    const providerRepo = { ...repo, id: 'git:git.example.com/org/orca' }
    const providerWorktree = { ...worktree, repoId: providerRepo.id, workspaceStatus: 'todo' }

    expect(
      getSecondaryStatusDragSourceGroupKey({
        sourceGroupKey: 'pinned',
        draggingWorktreeId: providerWorktree.id,
        groupBy: 'repo',
        groupBySecondary: 'workspace-status',
        worktreeMap: new Map([[providerWorktree.id, providerWorktree]]),
        repoMap: new Map([[providerRepo.id, providerRepo]]),
        prCache: null,
        workspaceStatuses: STATUSES,
        settings: undefined,
        projectGroups: [],
        projectGrouping: undefined
      })
    ).toBe('repo:git:git.example.com/org/orca/workspace-status:todo')
  })
})
