import { describe, expect, it } from 'vitest'
import type { WorkspaceStatusDefinition } from '../../../../../../shared/worktree/types'
import {
  getWorkspaceStatusTargetGroupKey,
  shouldPreferSidebarStatusDropTarget
} from './status-target'

const STATUSES: WorkspaceStatusDefinition[] = [
  { id: 'todo', label: 'Todo' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'completed', label: 'Done' }
]

describe('nested workspace status drag targets', () => {
  it('prefers an adjacent status header when Status is the secondary grouping', () => {
    expect(
      shouldPreferSidebarStatusDropTarget({
        sourceGroupKey: 'project:git:git.example.com/org/workspace-status:todo',
        target: { status: 'in-progress', isPinDrop: false },
        workspaceStatuses: STATUSES
      })
    ).toBe(true)
  })

  it('prefers an exact nested Status lane for a drag originating in Pinned', () => {
    expect(
      shouldPreferSidebarStatusDropTarget({
        sourceGroupKey: 'pinned',
        target: {
          status: 'in-progress',
          groupKey: 'repo:repo-1/workspace-status:in-progress',
          isPinDrop: false
        },
        workspaceStatuses: STATUSES
      })
    ).toBe(true)
  })

  it('does not turn a hover inside the exact source lane into a status move', () => {
    const groupKey = 'repo:repo-1/workspace-status:in-progress'

    expect(
      shouldPreferSidebarStatusDropTarget({
        sourceGroupKey: groupKey,
        target: { status: 'in-progress', groupKey, isPinDrop: false },
        workspaceStatuses: STATUSES
      })
    ).toBe(false)
  })

  it('replaces a secondary Status segment while preserving its Project parent', () => {
    expect(
      getWorkspaceStatusTargetGroupKey({
        sourceGroupKey: 'project:git:git.example.com/org/workspace-status:todo',
        status: 'in-progress',
        workspaceStatuses: STATUSES
      })
    ).toBe('project:git:git.example.com/org/workspace-status:in-progress')
  })

  it('replaces a primary Status segment while preserving its secondary Project lane', () => {
    expect(
      getWorkspaceStatusTargetGroupKey({
        sourceGroupKey: 'workspace-status:todo/project:git:git.example.com/org',
        status: 'completed',
        workspaceStatuses: STATUSES
      })
    ).toBe('workspace-status:completed/project:git:git.example.com/org')
  })

  it('encodes custom status IDs without confusing slashes in Project keys', () => {
    const customStatuses = [...STATUSES, { id: 'qa / blocked', label: 'QA / blocked' }]

    expect(
      getWorkspaceStatusTargetGroupKey({
        sourceGroupKey: 'project:git:git.example.com/org/workspace-status:todo',
        status: 'qa / blocked',
        workspaceStatuses: customStatuses
      })
    ).toBe('project:git:git.example.com/org/workspace-status:qa%20%2F%20blocked')
  })

  it('ignores a status-like path segment inside a provider Project ID', () => {
    expect(
      getWorkspaceStatusTargetGroupKey({
        sourceGroupKey:
          'project:git:git.example.com/workspace-status:todo/orca/workspace-status:in-progress',
        status: 'completed',
        workspaceStatuses: STATUSES
      })
    ).toBe('project:git:git.example.com/workspace-status:todo/orca/workspace-status:completed')
  })
})
