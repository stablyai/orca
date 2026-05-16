import { describe, expect, it } from 'vitest'
import {
  cloneDefaultWorkspaceStatuses,
  normalizePersistedWorkspaceStatuses,
  normalizeWorkspaceStatuses
} from './workspace-statuses'

describe('workspace status visuals', () => {
  it('keeps todo first by default', () => {
    expect(cloneDefaultWorkspaceStatuses().map((status) => status.id)).toEqual([
      'todo',
      'in-progress',
      'in-review',
      'completed'
    ])
  })

  it('migrates the old default status visuals without reordering the board', () => {
    const statuses = normalizePersistedWorkspaceStatuses(
      [
        { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' },
        { id: 'in-progress', label: 'In progress', color: 'blue', icon: 'circle-dot' },
        { id: 'in-review', label: 'In review', color: 'violet', icon: 'git-pull-request' },
        { id: 'completed', label: 'Completed', color: 'emerald', icon: 'circle-check' }
      ],
      { migrateLegacyDefaultStatusVisuals: true }
    )

    expect(statuses.map((status) => status.id)).toEqual([
      'todo',
      'in-progress',
      'in-review',
      'completed'
    ])
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

  it('preserves default-label reordered statuses unless the one-shot repair is requested', () => {
    const statuses = normalizePersistedWorkspaceStatuses([
      { id: 'completed', label: 'Completed', color: 'conductor-done', icon: 'conductor-done' },
      { id: 'in-review', label: 'In review', color: 'conductor-review', icon: 'conductor-review' },
      {
        id: 'in-progress',
        label: 'In progress',
        color: 'conductor-progress',
        icon: 'conductor-progress'
      },
      { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }
    ])

    expect(statuses.map((status) => status.id)).toEqual([
      'completed',
      'in-review',
      'in-progress',
      'todo'
    ])
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

  it('leaves custom persisted status layouts in their saved order', () => {
    const statuses = normalizePersistedWorkspaceStatuses([
      { id: 'completed', label: 'Shipped', color: 'conductor-done', icon: 'conductor-done' },
      { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }
    ])

    expect(statuses.map((status) => status.id)).toEqual(['completed', 'todo'])
  })

  it('uses Conductor-style visuals for the default status icons', () => {
    const statuses = cloneDefaultWorkspaceStatuses()
    const inProgress = statuses.find((status) => status.id === 'in-progress')
    const inReview = statuses.find((status) => status.id === 'in-review')
    const completed = statuses.find((status) => status.id === 'completed')

    expect(inProgress).toMatchObject({
      color: 'conductor-progress',
      icon: 'conductor-progress'
    })
    expect(inReview).toMatchObject({
      color: 'conductor-review',
      icon: 'conductor-review'
    })
    expect(completed).toMatchObject({
      color: 'conductor-done',
      icon: 'conductor-done'
    })
  })

  it('migrates the old in-progress blue dot default only when requested', () => {
    const statuses = normalizePersistedWorkspaceStatuses(
      [{ id: 'in-progress', label: 'In progress', color: 'blue', icon: 'circle-dot' }],
      { migrateLegacyDefaultStatusVisuals: true }
    )

    expect(statuses[0]).toMatchObject({
      color: 'conductor-progress',
      icon: 'conductor-progress'
    })
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

  it('keeps intentional custom in-progress visuals', () => {
    const statuses = normalizeWorkspaceStatuses([
      { id: 'in-progress', label: 'Doing', color: 'blue', icon: 'circle-dot' }
    ])

    expect(statuses[0]).toMatchObject({
      color: 'blue',
      icon: 'circle-dot'
    })
  })
})
