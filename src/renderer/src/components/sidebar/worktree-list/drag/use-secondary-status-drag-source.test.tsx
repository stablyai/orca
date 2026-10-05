// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { repoMap, worktree } from '../../worktree-list-groups-test-fixtures'
import { useSecondaryStatusDragSource } from './use-secondary-status-drag-source'

const STATUSES = [
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'completed', label: 'Done' }
]

function renderDragSource() {
  return renderHook(() =>
    useSecondaryStatusDragSource({
      groupBy: 'repo',
      groupBySecondary: 'workspace-status',
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap,
      prCache: null,
      workspaceStatuses: STATUSES,
      settings: undefined,
      projectGroups: [],
      projectGrouping: undefined
    })
  )
}

describe('secondary Status drag lifecycle', () => {
  it('exposes the source lane only for the duration of a drag', () => {
    const view = renderDragSource()

    expect(view.result.current.emptySecondaryStatusSourceGroupKey).toBeNull()

    act(() => {
      view.result.current.onWorktreeDragSourceChange(
        'repo:repo-1/workspace-status:in-progress',
        worktree.id
      )
    })
    expect(view.result.current.emptySecondaryStatusSourceGroupKey).toBe(
      'repo:repo-1/workspace-status:in-progress'
    )

    act(() => {
      view.result.current.onWorktreeDragSourceChange(null, null)
    })
    expect(view.result.current.emptySecondaryStatusSourceGroupKey).toBeNull()
  })

  it('resolves a pinned drag to its natural nested lane', () => {
    const view = renderDragSource()

    act(() => {
      view.result.current.onWorktreeDragSourceChange('pinned', worktree.id)
    })

    expect(view.result.current.emptySecondaryStatusSourceGroupKey).toBe(
      'repo:repo-1/workspace-status:in-progress'
    )
  })
})
