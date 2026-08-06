import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import {
  getRelativeWorktreeDefaultName,
  getRelativeWorktreeParent
} from './worktree-relative-create'

const worktree = {
  id: 'repo-1::/worktrees/feature',
  repoId: 'repo-1',
  branch: 'refs/heads/feature/menu',
  displayName: 'Menu work',
  path: '/worktrees/feature'
} as Worktree

describe('relative worktree create defaults', () => {
  it('suffixes the source branch for fork and child names', () => {
    expect(getRelativeWorktreeDefaultName(worktree, 'fork')).toBe('feature/menu_fork')
    expect(getRelativeWorktreeDefaultName(worktree, 'child')).toBe('feature/menu_child')
  })

  it('makes a child descend from the selected worktree', () => {
    expect(getRelativeWorktreeParent({ kind: 'child', worktree })).toBe(`worktree:${worktree.id}`)
  })

  it('makes a fork inherit the selected worktree parent', () => {
    expect(
      getRelativeWorktreeParent({
        kind: 'fork',
        worktree,
        workspaceLineage: {
          childWorkspaceKey: `worktree:${worktree.id}`,
          parentWorkspaceKey: 'folder:project-1',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        }
      })
    ).toBe('folder:project-1')
  })

  it('keeps a top-level fork at the top level', () => {
    expect(getRelativeWorktreeParent({ kind: 'fork', worktree })).toBeNull()
  })

  it('inherits a worktree parent only after instance validation succeeds', () => {
    expect(
      getRelativeWorktreeParent({
        kind: 'fork',
        worktree,
        workspaceLineage: {
          childWorkspaceKey: `worktree:${worktree.id}`,
          childInstanceId: 'child-instance',
          parentWorkspaceKey: 'worktree:repo-1::/worktrees/parent',
          parentInstanceId: 'parent-instance',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        },
        validParentWorktreeId: 'repo-1::/worktrees/parent'
      })
    ).toBe('worktree:repo-1::/worktrees/parent')
  })

  it('rejects a stale worktree parent that failed instance validation', () => {
    expect(
      getRelativeWorktreeParent({
        kind: 'fork',
        worktree,
        workspaceLineage: {
          childWorkspaceKey: `worktree:${worktree.id}`,
          childInstanceId: 'child-instance',
          parentWorkspaceKey: 'worktree:repo-1::/worktrees/reused-parent',
          parentInstanceId: 'stale-parent-instance',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        },
        validParentWorktreeId: null
      })
    ).toBeNull()
  })
})
