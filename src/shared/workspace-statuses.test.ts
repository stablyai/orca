import { describe, expect, it } from 'vitest'
import {
  cloneDefaultWorkspaceStatuses,
  normalizePersistedWorkspaceStatuses,
  normalizeWorkspaceStatuses
} from './workspace-statuses'

describe('workspace status visuals', () => {
  it('normalizes every valid status without truncating the workflow', () => {
    const authored = Array.from({ length: 500 }, (_, index) => ({
      id: `state-${index}`,
      label: `State ${index}`
    }))

    expect(normalizeWorkspaceStatuses(authored).map((status) => status.id)).toEqual(
      authored.map((status) => status.id)
    )
  })

  it('migrates legacy default statuses to the default workflow order', () => {
    const statuses = normalizePersistedWorkspaceStatuses(
      [
        { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' },
        {
          id: 'in-progress',
          label: 'In progress',
          color: 'conductor-progress',
          icon: 'conductor-progress'
        },
        {
          id: 'in-review',
          label: 'In review',
          color: 'conductor-review',
          icon: 'conductor-review'
        },
        { id: 'completed', label: 'Completed', color: 'conductor-done', icon: 'conductor-done' }
      ],
      { migrateDefaultWorkflowStatuses: true }
    )

    expect(statuses).toEqual(cloneDefaultWorkspaceStatuses())
  })

  it('preserves explicit status order while migrating default visuals', () => {
    const statuses = normalizePersistedWorkspaceStatuses(
      [
        { id: 'completed', label: 'Completed', color: 'emerald', icon: 'circle-check' },
        { id: 'in-review', label: 'In review', color: 'violet', icon: 'git-pull-request' },
        { id: 'in-progress', label: 'In progress', color: 'blue', icon: 'circle-dot' },
        { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }
      ],
      { migrateLegacyDefaultStatusVisuals: true }
    )

    expect(statuses.map((status) => status.id)).toEqual([
      'completed',
      'in-review',
      'in-progress',
      'todo'
    ])
    expect(statuses[0]).toMatchObject({
      color: 'conductor-done',
      icon: 'conductor-done'
    })
  })

  it('migrates exact reordered default statuses to the new Done label when requested', () => {
    const statuses = normalizePersistedWorkspaceStatuses(
      [
        { id: 'completed', label: 'Completed', color: 'conductor-done', icon: 'conductor-done' },
        {
          id: 'in-review',
          label: 'In review',
          color: 'conductor-review',
          icon: 'conductor-review'
        },
        {
          id: 'in-progress',
          label: 'In progress',
          color: 'conductor-progress',
          icon: 'conductor-progress'
        },
        { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }
      ],
      { migrateDefaultWorkflowStatuses: true }
    )

    expect(statuses).toEqual(cloneDefaultWorkspaceStatuses())
  })

  it('repairs the exact PR-introduced default status reorder when migration-gated', () => {
    const statuses = normalizePersistedWorkspaceStatuses(
      [
        { id: 'completed', label: 'Completed', color: 'conductor-done', icon: 'conductor-done' },
        {
          id: 'in-review',
          label: 'In review',
          color: 'conductor-review',
          icon: 'conductor-review'
        },
        {
          id: 'in-progress',
          label: 'In progress',
          color: 'conductor-progress',
          icon: 'conductor-progress'
        },
        { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }
      ],
      { repairReorderedDefaultStatuses: true }
    )

    expect(statuses).toEqual(cloneDefaultWorkspaceStatuses())
  })

  it('does not repair reordered default-label statuses with a different raw shape', () => {
    const statuses = normalizePersistedWorkspaceStatuses(
      [
        { id: 'completed', label: 'Completed', color: 'emerald', icon: 'circle-check' },
        { id: 'in-review', label: 'In review', color: 'violet', icon: 'git-pull-request' },
        { id: 'in-progress', label: 'In progress', color: 'blue', icon: 'circle-dot' },
        { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }
      ],
      { repairReorderedDefaultStatuses: true }
    )

    expect(statuses.map((status) => status.id)).toEqual([
      'completed',
      'in-review',
      'in-progress',
      'todo'
    ])
  })

  it('preserves valid legacy visuals for default-label statuses at runtime', () => {
    const statuses = normalizeWorkspaceStatuses([
      { id: 'in-progress', label: 'In progress', color: 'blue', icon: 'circle-dot' }
    ])

    expect(statuses[0]).toMatchObject({
      color: 'blue',
      icon: 'circle-dot'
    })
  })

  it('truncates long labels without splitting an emoji surrogate pair', () => {
    const [status] = normalizeWorkspaceStatuses([
      { id: 'review', label: `${'a'.repeat(31)}🚀 later` }
    ])

    expect(status.label).toBe('a'.repeat(31))
  })
})
