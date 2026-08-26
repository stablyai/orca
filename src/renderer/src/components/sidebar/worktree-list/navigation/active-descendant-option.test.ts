import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { getWorktreeOptionId } from '../rows/option-dom'
import { getActiveDescendantOptionId } from './active-descendant-option'

function row(hostId: Worktree['hostId']): WorktreeItemRow {
  return {
    type: 'item',
    rowKey: `all:${hostId}|shared`,
    sectionKey: 'all',
    worktree: { id: 'shared', repoId: 'repo', hostId } as Worktree,
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

describe('getActiveDescendantOptionId', () => {
  it('announces the active host row when workspace ids collide', () => {
    const local = row('local')
    const ssh = row('ssh:box')

    expect(
      getActiveDescendantOptionId({
        activeWorktreeId: 'shared',
        activeWorkspaceExecutionHostId: 'ssh:box',
        pinnedDisplayPolicy: 'single-location',
        renderRows: [local, ssh],
        virtualItems: [{ index: 0 }, { index: 1 }]
      })
    ).toBe(getWorktreeOptionId(ssh.rowKey))
  })
})
