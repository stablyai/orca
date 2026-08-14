// @vitest-environment happy-dom
// Why: verify kanban board shows ALL single-select/iteration options as columns
// (including empty), renders cards, and sends correct drag-and-drop field
// mutations (single-select and iteration kinds).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ProjectViewKanban from './ProjectViewKanban'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'

afterEach(cleanup)

function makeTable(opts?: {
  groupFieldId?: string
  groupFieldName?: string
  groupKind?: 'single-select' | 'iteration'
  optionIds?: string[]
  optionNames?: string[]
  optionColors?: string[]
  iterationIds?: string[]
  iterationNames?: string[]
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
        opts?.groupKind === 'iteration'
          ? {
              kind: 'iteration',
              id: groupFieldId,
              name: groupFieldName,
              dataType: 'ITERATION',
              iterations: (opts?.iterationIds ?? ['iter_1', 'iter_2']).map((id, i) => ({
                id,
                title: (opts?.iterationNames ?? ['Sprint 1', 'Sprint 2'])[i] ?? id,
                startDate: '2026-01-01',
                duration: 14,
                completed: false
              }))
            }
          : {
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
  iterationId?: string
  groupFieldId?: string
  assigneeCount?: number
  labelCount?: number
}): GitHubProjectRow {
  const groupFieldId = opts?.groupFieldId ?? 'status'
  let fieldValue: GitHubProjectRow['fieldValuesByFieldId'][string] | undefined
  if (opts?.iterationId) {
    fieldValue = {
      kind: 'iteration',
      fieldId: groupFieldId,
      iterationId: opts.iterationId,
      title: opts.iterationId,
      startDate: '2026-01-01',
      duration: 14
    }
  } else if (opts?.optionId) {
    fieldValue = {
      kind: 'single-select',
      fieldId: groupFieldId,
      optionId: opts.optionId,
      name: opts.optionId,
      color: ''
    }
  }
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
    fieldValuesByFieldId: fieldValue ? { [groupFieldId]: fieldValue } : {},
    updatedAt: '2025-01-01',
    position: 1
  }
}

function makeDataTransfer() {
  return { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
}

function dragCardToColumn(cardLabel: string, columnLabel: string) {
  const card = screen.getByRole('button', { name: new RegExp(cardLabel) })
  const column = screen.getByText(columnLabel).parentElement?.parentElement
  if (!column) {
    throw new Error(`column ${columnLabel} not found`)
  }
  const dt = makeDataTransfer()
  fireEvent.dragStart(card, { dataTransfer: dt })
  fireEvent.dragOver(column, { dataTransfer: dt })
  fireEvent.dragEnd(card, { dataTransfer: dt })
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

  it('calls onEditField with single-select mutation on cross-column drop', () => {
    const onEditField = vi.fn()
    const r1 = makeRow({ id: 'r1', title: 'Issue 1', optionId: 'opt_todo' })
    const table = makeTable({
      optionIds: ['opt_todo', 'opt_done'],
      optionNames: ['Todo', 'Done'],
      rows: [r1, makeRow({ id: 'r2', title: 'Done task', optionId: 'opt_done' })]
    })
    render(<ProjectViewKanban table={table} onEditField={onEditField} />)
    dragCardToColumn('Issue 1', 'Done')
    expect(onEditField).toHaveBeenCalledTimes(1)
    expect(onEditField).toHaveBeenCalledWith(r1, 'status', {
      kind: 'single-select',
      optionId: 'opt_done'
    })
  })

  it('does not fire onEditField when dropping on the source column', () => {
    const onEditField = vi.fn()
    const table = makeTable({
      optionIds: ['opt_todo', 'opt_done'],
      optionNames: ['Todo', 'Done'],
      rows: [makeRow({ id: 'r1', title: 'Issue 1', optionId: 'opt_todo' })]
    })
    render(<ProjectViewKanban table={table} onEditField={onEditField} />)
    dragCardToColumn('Issue 1', 'Todo')
    expect(onEditField).not.toHaveBeenCalled()
  })

  it('calls onEditField with iteration mutation on an iteration-grouped board', () => {
    const onEditField = vi.fn()
    const r1 = makeRow({
      id: 'r1',
      title: 'Sprint 1 item',
      groupFieldId: 'sprint',
      iterationId: 'iter_1'
    })
    const table = makeTable({
      groupFieldId: 'sprint',
      groupFieldName: 'Sprint',
      groupKind: 'iteration',
      iterationIds: ['iter_1', 'iter_2'],
      iterationNames: ['Sprint 1', 'Sprint 2'],
      rows: [r1]
    })
    render(<ProjectViewKanban table={table} onEditField={onEditField} />)
    dragCardToColumn('Sprint 1 item', 'Sprint 2')
    expect(onEditField).toHaveBeenCalledTimes(1)
    expect(onEditField).toHaveBeenCalledWith(r1, 'sprint', {
      kind: 'iteration',
      iterationId: 'iter_2'
    })
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
