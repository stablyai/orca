import { describe, expect, it } from 'vitest'
import { normalizePersistedWorkspaceStatuses } from './workspace-statuses'

describe('workspace status visuals', () => {
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
})
