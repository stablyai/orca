import { describe, expect, it } from 'vitest'
import {
  countActiveWorkspaceFilters,
  filterWorkspaceRows,
  NO_WORKSPACE_ROW_FILTERS,
  type WorkspaceRowFactReader
} from './workspace-row-filters'

type Row = { id: string; status: string; folder?: boolean }

const facts: WorkspaceRowFactReader<Row> = {
  isArchived: () => false,
  isInHiddenProject: () => false,
  isProjectHidden: () => false,
  isFolderWorkspace: (row) => row.folder === true,
  repoId: () => 'repo',
  hostId: () => 'local',
  isOtherClient: () => false,
  isDefaultBranch: () => false,
  isAutomationCreated: () => false,
  isCliCreated: () => false,
  isDetachedHead: () => false,
  isMainWorktree: () => false,
  isSleeping: () => false,
  workspaceStatus: (row) => row.status
}

const rows: Row[] = [
  { id: 'a', status: 'todo' },
  { id: 'b', status: 'completed' },
  { id: 'c', status: 'in-review' },
  { id: 'd', status: 'completed', folder: true }
]

describe('Hide by status', () => {
  it('hides only the chosen statuses, folder workspaces included', () => {
    const shown = filterWorkspaceRows(
      rows,
      {
        ...NO_WORKSPACE_ROW_FILTERS,
        hideWorkspacesByStatus: true,
        hiddenWorkspaceStatusIds: ['completed', 'in-review']
      },
      facts
    )
    expect(shown.map((row) => row.id)).toEqual(['a'])
  })

  it('keeps every row while the filter is off, whatever statuses are chosen', () => {
    const filters = {
      ...NO_WORKSPACE_ROW_FILTERS,
      hiddenWorkspaceStatusIds: ['todo', 'completed']
    }
    expect(filterWorkspaceRows(rows, filters, facts).map((row) => row.id)).toEqual([
      'a',
      'b',
      'c',
      'd'
    ])
    expect(countActiveWorkspaceFilters(filters, [])).toBe(0)
  })

  it('counts as one filter however many statuses it hides', () => {
    expect(
      countActiveWorkspaceFilters(
        {
          ...NO_WORKSPACE_ROW_FILTERS,
          hideWorkspacesByStatus: true,
          hiddenWorkspaceStatusIds: ['todo', 'in-review']
        },
        []
      )
    ).toBe(1)
  })
})
