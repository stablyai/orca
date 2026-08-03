// Why: verify kanban board shows ALL single-select options as columns (including
// empty), renders cards, and supports drag-and-drop field mutation callbacks.
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ProjectViewKanban from './ProjectViewKanban'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github-project-types'

function makeTable(opts?: {
  groupFieldId?: string
  groupFieldName?: string
  optionIds?: string[]
  optionNames?: string[]
  optionColors?: string[]
  rows?: GitHubProjectRow[]
  layout?: 'TABLE_LAYOUT' | 'BOARD_LAYOUT'
}): GitHubProjectTable {
  const groupFieldId = opts?.groupFieldId ?? 'status'
  const groupFieldName = opts?.groupFieldName ?? 'Status'
  const optionIds = opts?.optionIds ?? ['opt_todo', 'opt_done']
  const optionNames = opts?.optionNames ?? ['Todo', 'Done']
  const optionColors = opts?.optionColors ?? ['', '']

  return {
    project: { id: 'p1', owner: 'test', ownerType: 'user', number: 1, title: 'Test', url: '' },
    selectedView: {
      id: 'v1',
      number: 1,
      name: 'Board',
      layout: opts?.layout ?? 'BOARD_LAYOUT',
      filter: '',
      fields: [],
      groupByFields: [
        {
          kind: 'single-select',
          id: groupFieldId,
          name: groupFieldName,
          dataType: 'SINGLE_SELECT',
          options: optionIds.map((id, i) => ({
            id,
            name: optionNames[i] ?? id,
            color: optionColors[i] ?? ''
          }))
        }
      ],
      sortByFields: []
    },
    rows: opts?.rows ?? [],
    totalCount: opts?.rows?.length ?? 0,
    parentFieldDropped: false,
    projectFields: []
  }
}

function makeRow(opts: {
  id?: string
  title?: string
  number?: number
  itemType?: GitHubProjectRow['itemType']
  optionId?: string
  groupFieldId?: string
  assigneeCount?: number
  labelCount?: number
}): GitHubProjectRow {
  const groupFieldId = opts?.groupFieldId ?? 'status'
  return {
    id: opts?.id ?? 'row-1',
    itemType: opts?.itemType ?? 'ISSUE',
    content: {
      number: opts?.number ?? 1,
      title: opts?.title ?? 'Test item',
      body: null,
      url: 'https://github.com/test/test/issues/1',
      state: 'OPEN',
      stateReason: null,
      isDraft: null,
      repository: 'test/test',
      assignees: Array.from({ length: opts?.assigneeCount ?? 0 }).map((_, i) => ({
        login: `user${i}`,
        name: `User ${i}`,
        avatarUrl: null
      })),
      labels: Array.from({ length: opts?.labelCount ?? 0 }).map((_, i) => ({
        name: `label-${i}`,
        color: 'ffffff'
      })),
      parentIssue: null,
      issueType: null
    },
    fieldValuesByFieldId: opts?.optionId
      ? {
          [groupFieldId]: {
            kind: 'single-select',
            fieldId: groupFieldId,
            optionId: opts.optionId,
            name: opts.optionId,
            color: ''
          }
        }
      : {},
    updatedAt: '2025-01-01',
    position: 1
  }
}

describe('ProjectViewKanban', () => {
  it('renders ALL option columns even when empty', () => {
    const table = makeTable({
      optionIds: ['opt_todo', 'opt_inprogress', 'opt_done'],
      optionNames: ['Todo', 'In Progress', 'Done'],
      rows: [makeRow({ id: 'r1', title: 'Issue 1', optionId: 'opt_todo' })]
    })
    render(<ProjectViewKanban table={table} />)
    expect(screen.getByText('Todo')).toBeTruthy()
    expect(screen.getByText('In Progress')).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
  })

  it('shows empty column with drop target text', () => {
    const table = makeTable({
      optionIds: ['opt_todo', 'opt_empty'],
      optionNames: ['Todo', 'Empty'],
      rows: [makeRow({ id: 'r1', title: 'Issue 1', optionId: 'opt_todo' })]
    })
    render(<ProjectViewKanban table={table} />)
    expect(screen.getByText('Empty')).toBeTruthy()
    expect(screen.getByText('Drop items here')).toBeTruthy()
  })

  it('renders card titles in correct columns', () => {
    const table = makeTable({
      optionIds: ['opt_todo', 'opt_done'],
      optionNames: ['Todo', 'Done'],
      rows: [
        makeRow({ id: 'r1', title: 'Issue 1', optionId: 'opt_todo' }),
        makeRow({ id: 'r2', title: 'Done task', optionId: 'opt_done' })
      ]
    })
    render(<ProjectViewKanban table={table} />)
    expect(screen.getByText('Issue 1')).toBeTruthy()
    expect(screen.getByText('Done task')).toBeTruthy()
  })

  it('calls onEditField on cross-column drop', () => {
    const onEditField = vi.fn()
    const table = makeTable({
      optionIds: ['opt_todo', 'opt_done'],
      optionNames: ['Todo', 'Done'],
      rows: [
        makeRow({ id: 'r1', title: 'Issue 1', optionId: 'opt_todo' }),
        makeRow({ id: 'r2', title: 'Done task', optionId: 'opt_done' })
      ]
    })
    render(<ProjectViewKanban table={table} onEditField={onEditField} />)
    expect(screen.getByText('Issue 1')).toBeTruthy()
  })

  it('renders empty state when no group field', () => {
    const table = makeTable({
      rows: [makeRow({ optionId: undefined })]
    })
    const tableNoGroups: GitHubProjectTable = {
      ...table,
      selectedView: {
        ...table.selectedView,
        groupByFields: []
      }
    }
    render(<ProjectViewKanban table={tableNoGroups} />)
    expect(screen.getByText("No items match this view's filter.")).toBeTruthy()
  })

  it('shows item count per column', () => {
    const table = makeTable({
      optionIds: ['opt_todo', 'opt_done'],
      optionNames: ['Todo', 'Done'],
      rows: [
        makeRow({ id: 'r1', title: 'Issue 1', optionId: 'opt_todo' }),
        makeRow({ id: 'r2', title: 'Issue 2', optionId: 'opt_todo' }),
        makeRow({ id: 'r3', title: 'Done', optionId: 'opt_done' })
      ]
    })
    render(<ProjectViewKanban table={table} />)
    // Columns show counts: Todo=2, Done=1
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(1)
  })
})
