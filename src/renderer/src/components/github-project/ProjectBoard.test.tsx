// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectBoard from './ProjectBoard'
import type {
  GitHubProjectField,
  GitHubProjectFieldValue,
  GitHubProjectRow,
  GitHubProjectTable
} from '../../../../shared/github/project-types'

const STATUS_FIELD: GitHubProjectField = {
  kind: 'single-select',
  id: 'f_status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'opt_todo', name: 'Todo', color: 'GREEN' },
    { id: 'opt_done', name: 'Done', color: 'PURPLE' }
  ]
}
const TITLE_FIELD: GitHubProjectField = {
  kind: 'field',
  id: 'f_title',
  name: 'Title',
  dataType: 'TITLE'
}

function row(
  id: string,
  title: string,
  values: GitHubProjectFieldValue[],
  itemType: GitHubProjectRow['itemType'] = 'ISSUE'
): GitHubProjectRow {
  const fieldValuesByFieldId: Record<string, GitHubProjectFieldValue> = {}
  for (const value of values) {
    fieldValuesByFieldId[value.fieldId] = value
  }
  return {
    id,
    itemType,
    content: {
      number: itemType === 'DRAFT_ISSUE' || itemType === 'REDACTED' ? null : 7,
      title,
      body: null,
      url: 'https://github.com/o/r/issues/7',
      state: 'OPEN',
      stateReason: null,
      isDraft: null,
      repository: 'o/r',
      assignees: [],
      labels: [],
      parentIssue: null,
      issueType: null
    },
    fieldValuesByFieldId,
    updatedAt: '2026-09-01T00:00:00Z',
    position: 0
  }
}

function table(fields: GitHubProjectField[], rows: GitHubProjectRow[]): GitHubProjectTable {
  return {
    project: {
      id: 'PVT_1',
      owner: 'o',
      ownerType: 'user',
      number: 1,
      title: 'Project',
      url: 'https://github.com/users/o/projects/1'
    },
    selectedView: {
      id: 'PVTV_1',
      number: 1,
      name: 'Board',
      layout: 'BOARD_LAYOUT',
      filter: '',
      fields,
      groupByFields: [],
      sortByFields: [],
      verticalGroupByFields: fields.filter((field) => field.kind === 'single-select')
    },
    rows,
    totalCount: rows.length,
    parentFieldDropped: false
  }
}

const status = (optionId: string, name: string): GitHubProjectFieldValue => ({
  kind: 'single-select',
  fieldId: 'f_status',
  optionId,
  name,
  color: ''
})

function dragData(rowId: string): { dataTransfer: Partial<DataTransfer> } {
  const store: Record<string, string> = { 'application/x-orca-project-row': rowId }
  return {
    dataTransfer: {
      types: Object.keys(store),
      getData: (type: string) => store[type] ?? '',
      setData: (type: string, value: string) => {
        store[type] = value
      },
      dropEffect: 'move',
      effectAllowed: 'move'
    } as unknown as DataTransfer
  }
}

afterEach(cleanup)

describe('ProjectBoard', () => {
  it('renders one column per option (empty included) plus the no-value column', () => {
    render(
      <ProjectBoard
        table={table(
          [TITLE_FIELD, STATUS_FIELD],
          [row('r1', 'Ship it', [status('opt_todo', 'Todo')]), row('r2', 'Loose end', [])]
        )}
        fallback={<div>list</div>}
      />
    )
    expect(screen.getByTestId('board-column-opt_todo')).toBeTruthy()
    expect(screen.getByTestId('board-column-opt_done')).toBeTruthy()
    expect(screen.getByTestId('board-column-__empty__').textContent).toContain('Loose end')
    expect(screen.queryByText('list')).toBeNull()
  })

  it('moves a card on drop via onEditField and skips no-op drops', () => {
    const onEditField = vi.fn()
    const boardTable = table(
      [TITLE_FIELD, STATUS_FIELD],
      [row('r1', 'Ship it', [status('opt_todo', 'Todo')])]
    )
    render(<ProjectBoard table={boardTable} onEditField={onEditField} fallback={<div>list</div>} />)
    fireEvent.drop(screen.getByTestId('board-column-opt_done'), dragData('r1'))
    expect(onEditField).toHaveBeenCalledWith(boardTable.rows[0], 'f_status', {
      kind: 'single-select',
      optionId: 'opt_done'
    })
    onEditField.mockClear()
    fireEvent.drop(screen.getByTestId('board-column-opt_todo'), dragData('r1'))
    expect(onEditField).not.toHaveBeenCalled()
  })

  it('clears the field when dropped on the no-value column', () => {
    const onEditField = vi.fn()
    const boardTable = table(
      [TITLE_FIELD, STATUS_FIELD],
      [row('r1', 'Ship it', [status('opt_todo', 'Todo')])]
    )
    render(<ProjectBoard table={boardTable} onEditField={onEditField} fallback={<div>list</div>} />)
    fireEvent.drop(screen.getByTestId('board-column-__empty__'), dragData('r1'))
    expect(onEditField).toHaveBeenCalledWith(boardTable.rows[0], 'f_status', null)
  })

  it('opens the dialog from a card title and labels restricted cards', () => {
    const onOpenDialog = vi.fn()
    render(
      <ProjectBoard
        table={table(
          [TITLE_FIELD, STATUS_FIELD],
          [
            row('r1', 'Ship it', [status('opt_todo', 'Todo')]),
            row('r2', '', [status('opt_todo', 'Todo')], 'REDACTED')
          ]
        )}
        onOpenDialog={onOpenDialog}
        fallback={<div>list</div>}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Ship it/ }))
    expect(onOpenDialog).toHaveBeenCalledTimes(1)
    expect(onOpenDialog.mock.calls[0]?.[0]).toMatchObject({ id: 'r1' })
    expect(screen.getByText('Restricted item')).toBeTruthy()
  })

  it('clears the drop highlight on dragend and on payload-less drops', () => {
    render(
      <ProjectBoard
        table={table(
          [TITLE_FIELD, STATUS_FIELD],
          [row('r1', 'Ship it', [status('opt_todo', 'Todo')])]
        )}
        fallback={<div>list</div>}
      />
    )
    const done = screen.getByTestId('board-column-opt_done')
    fireEvent.dragOver(done, dragData('r1'))
    expect(done.className).toContain('border-ring')
    // Esc / drop outside any column fires only dragend on the card.
    fireEvent.dragEnd(screen.getByLabelText('#7 — Ship it'))
    expect(done.className).not.toContain('border-ring')
    fireEvent.dragOver(done, dragData('r1'))
    expect(done.className).toContain('border-ring')
    fireEvent.drop(done, { dataTransfer: { getData: () => '', types: [] } })
    expect(done.className).not.toContain('border-ring')
  })

  it('falls back to the caller-supplied list when no column field exists', () => {
    const bare = table([TITLE_FIELD], [row('r1', 'Ship it', [])])
    bare.selectedView.verticalGroupByFields = []
    render(<ProjectBoard table={bare} fallback={<div>list</div>} />)
    expect(screen.getByText('list')).toBeTruthy()
  })

  it('reports an empty filter result instead of drawing empty columns', () => {
    render(
      <ProjectBoard table={table([TITLE_FIELD, STATUS_FIELD], [])} fallback={<div>list</div>} />
    )
    expect(screen.getByText("No items match this view's filter.")).toBeTruthy()
    expect(screen.queryByTestId('board-column-opt_todo')).toBeNull()
  })
})
