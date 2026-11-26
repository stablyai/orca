import { describe, expect, it } from 'vitest'
import {
  activeWorkspaceRowFilterKeys,
  filterWorkspaceRows,
  NO_WORKSPACE_ROW_FILTERS,
  type WorkspaceRowFactReader
} from './workspace-row-filters'

type Row = { id: string; status?: string; folder?: boolean }

const ROWS: Row[] = [
  { id: 'todo', status: 'todo' },
  { id: 'working', status: 'in-progress' },
  { id: 'done', status: 'completed' },
  { id: 'folder-done', status: 'completed', folder: true }
]

const READ: WorkspaceRowFactReader<Row> = {
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
  isDone: (row) => row.status === 'completed',
  isMainWorktree: () => false,
  isSleeping: () => false
}

describe('hideDoneWorkspaces', () => {
  it('keeps every row by default', () => {
    expect(filterWorkspaceRows(ROWS, NO_WORKSPACE_ROW_FILTERS, READ).map((row) => row.id)).toEqual([
      'todo',
      'working',
      'done',
      'folder-done'
    ])
  })

  it('hides worktree and folder rows in Done, and counts as an active filter', () => {
    const filters = { ...NO_WORKSPACE_ROW_FILTERS, hideDoneWorkspaces: true }

    expect(filterWorkspaceRows(ROWS, filters, READ).map((row) => row.id)).toEqual([
      'todo',
      'working'
    ])
    expect(activeWorkspaceRowFilterKeys(filters)).toContain('hideDoneWorkspaces')
  })
})
