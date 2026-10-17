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
const LOCAL_TARGET = { kind: 'local' } as const
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
    }
  }
}

afterEach(cleanup)

describe('ProjectBoard', () => {
  it('renders one column per option (empty included) plus the no-value column', () => {
    render(
      <ProjectBoard
        sourceTarget={LOCAL_TARGET}
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
    render(
      <ProjectBoard
        sourceTarget={LOCAL_TARGET}
        table={boardTable}
        onEditField={onEditField}
        fallback={<div>list</div>}
      />
    )
    fireEvent.drop(screen.getByTestId('board-column-opt_done'), dragData('r1'))
    expect(onEditField).toHaveBeenCalledWith(boardTable.rows[0], 'f_status', {
      kind: 'single-select',
      optionId: 'opt_done'
    })
    onEditField.mockClear()
    fireEvent.drop(screen.getByTestId('board-column-opt_todo'), dragData('r1'))
    expect(onEditField).not.toHaveBeenCalled()
  })

  it('commits a drop even when the preload stops propagation at document capture', () => {
    const preloadDrop = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('drop', preloadDrop, true)
    try {
      const onEditField = vi.fn()
      render(
        <ProjectBoard
          sourceTarget={LOCAL_TARGET}
          table={table([STATUS_FIELD], [row('r1', 'Ship it', [])])}
          onEditField={onEditField}
          fallback={null}
        />
      )
      fireEvent.drop(screen.getByTestId('board-column-opt_done'), dragData('r1'))
      expect(onEditField).toHaveBeenCalledOnce()
    } finally {
      document.removeEventListener('drop', preloadDrop, true)
    }
  })

  it('clears the field when dropped on the no-value column', () => {
    const onEditField = vi.fn()
    const boardTable = table(
      [TITLE_FIELD, STATUS_FIELD],
      [row('r1', 'Ship it', [status('opt_todo', 'Todo')])]
    )
    render(
      <ProjectBoard
        sourceTarget={LOCAL_TARGET}
        table={boardTable}
        onEditField={onEditField}
        fallback={<div>list</div>}
      />
    )
    fireEvent.drop(screen.getByTestId('board-column-__empty__'), dragData('r1'))
    expect(onEditField).toHaveBeenCalledWith(boardTable.rows[0], 'f_status', null)
  })

  it('opens the dialog from a card title and labels restricted cards', () => {
    const onOpenDialog = vi.fn()
    render(
      <ProjectBoard
        sourceTarget={LOCAL_TARGET}
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
        sourceTarget={LOCAL_TARGET}
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
    render(<ProjectBoard sourceTarget={LOCAL_TARGET} table={bare} fallback={<div>list</div>} />)
    expect(screen.getByText('list')).toBeTruthy()
  })

  it('uses the shared empty-state copy for unfiltered and filtered boards', () => {
    const empty = table([TITLE_FIELD, STATUS_FIELD], [])
    const { rerender } = render(
      <ProjectBoard sourceTarget={LOCAL_TARGET} table={empty} fallback={<div>list</div>} />
    )
    expect(screen.getByText('This view has no items yet.')).toBeTruthy()
    expect(screen.queryByText("No items match this view's filter.")).toBeNull()
    empty.selectedView.filter = 'status:Done'
    rerender(
      <ProjectBoard sourceTarget={LOCAL_TARGET} table={{ ...empty }} fallback={<div>list</div>} />
    )
    expect(screen.getByText("No items match this view's filter.")).toBeTruthy()
  })

  it('ignores restricted and unknown payloads and deleted-option drops', () => {
    const onEditField = vi.fn()
    render(
      <ProjectBoard
        sourceTarget={LOCAL_TARGET}
        table={table(
          [STATUS_FIELD],
          [row('r1', '', [], 'REDACTED'), row('r2', 'Old', [status('deleted', 'Archived')])]
        )}
        onEditField={onEditField}
        fallback={<div>list</div>}
      />
    )
    fireEvent.drop(screen.getByTestId('board-column-opt_done'), dragData('r1'))
    fireEvent.drop(screen.getByTestId('board-column-opt_done'), dragData('unknown'))
    fireEvent.drop(screen.getByTestId('board-column-deleted'), dragData('r2'))
    expect(onEditField).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Restricted item').getAttribute('draggable')).toBe('false')
  })

  it('keeps a board without an edit handler read-only', () => {
    render(
      <ProjectBoard
        sourceTarget={LOCAL_TARGET}
        table={table([STATUS_FIELD], [row('r1', 'Read only', [])])}
        fallback={null}
      />
    )
    expect(screen.getByLabelText('#7 — Read only').getAttribute('draggable')).toBe('false')
  })

  describe('swimlanes', () => {
    const PRIORITY_FIELD: GitHubProjectField = {
      kind: 'single-select',
      id: 'f_priority',
      name: 'Priority',
      dataType: 'SINGLE_SELECT',
      options: [
        { id: 'p_high', name: 'High', color: 'RED' },
        { id: 'p_low', name: 'Low', color: 'GRAY' }
      ]
    }
    const ASSIGNEES_FIELD: GitHubProjectField = {
      kind: 'field',
      id: 'f_assignees',
      name: 'Assignees',
      dataType: 'ASSIGNEES'
    }
    const priority = (optionId: string, name: string): GitHubProjectFieldValue => ({
      kind: 'single-select',
      fieldId: 'f_priority',
      optionId,
      name,
      color: ''
    })
    function laneTable(
      laneField: GitHubProjectField,
      rows: GitHubProjectRow[]
    ): GitHubProjectTable {
      const base = table([TITLE_FIELD, STATUS_FIELD, laneField], rows)
      base.selectedView.verticalGroupByFields = [STATUS_FIELD]
      base.selectedView.groupByFields = [laneField]
      return base
    }

    it('splits every column across lanes, keeping a no-value lane last', () => {
      render(
        <ProjectBoard
          sourceTarget={LOCAL_TARGET}
          table={laneTable(PRIORITY_FIELD, [
            row('r1', 'Hot fix', [status('opt_todo', 'Todo'), priority('p_high', 'High')]),
            row('r2', 'Someday', [status('opt_done', 'Done')])
          ])}
          fallback={null}
        />
      )
      expect(screen.getByTestId('board-cell-p_high-opt_todo').textContent).toContain('Hot fix')
      expect(screen.getByTestId('board-cell-__empty__-opt_done').textContent).toContain('Someday')
      expect(screen.getByTestId('board-lane-__empty__').textContent).toContain('No Priority')
      expect(screen.queryByTestId('board-lane-p_low')).toBeNull()
    })

    it('writes the column and lane fields when a card crosses both', () => {
      const onEditField = vi.fn()
      const boardTable = laneTable(PRIORITY_FIELD, [
        row('r1', 'Hot fix', [status('opt_todo', 'Todo'), priority('p_high', 'High')]),
        row('r2', 'Someday', [status('opt_done', 'Done')])
      ])
      render(
        <ProjectBoard
          sourceTarget={LOCAL_TARGET}
          table={boardTable}
          onEditField={onEditField}
          fallback={null}
        />
      )
      fireEvent.drop(screen.getByTestId('board-cell-__empty__-opt_done'), dragData('r1'))
      expect(onEditField).toHaveBeenCalledWith(boardTable.rows[0], 'f_status', {
        kind: 'single-select',
        optionId: 'opt_done'
      })
      expect(onEditField).toHaveBeenCalledWith(boardTable.rows[0], 'f_priority', null)
      onEditField.mockClear()
      fireEvent.drop(screen.getByTestId('board-cell-p_high-opt_todo'), dragData('r2'))
      expect(onEditField).toHaveBeenCalledTimes(2)
      expect(onEditField).toHaveBeenLastCalledWith(boardTable.rows[1], 'f_priority', {
        kind: 'single-select',
        optionId: 'p_high'
      })
    })

    it('only moves the column when the lane field cannot be written', () => {
      const onEditField = vi.fn()
      const assignee = (login: string): GitHubProjectFieldValue => ({
        kind: 'users',
        fieldId: 'f_assignees',
        users: [{ login, name: null, avatarUrl: null }]
      })
      const boardTable = laneTable(ASSIGNEES_FIELD, [
        row('r1', 'Mine', [status('opt_todo', 'Todo'), assignee('ana')]),
        row('r2', 'Theirs', [status('opt_todo', 'Todo'), assignee('bo')])
      ])
      render(
        <ProjectBoard
          sourceTarget={LOCAL_TARGET}
          table={boardTable}
          onEditField={onEditField}
          fallback={null}
        />
      )
      fireEvent.drop(screen.getByTestId('board-cell-raw:bo-opt_done'), dragData('r1'))
      expect(onEditField).toHaveBeenCalledOnce()
      expect(onEditField).toHaveBeenCalledWith(boardTable.rows[0], 'f_status', {
        kind: 'single-select',
        optionId: 'opt_done'
      })
    })

    it('collapses a lane from its header', () => {
      render(
        <ProjectBoard
          sourceTarget={LOCAL_TARGET}
          table={laneTable(PRIORITY_FIELD, [
            row('r1', 'Hot fix', [status('opt_todo', 'Todo'), priority('p_high', 'High')])
          ])}
          fallback={null}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /High/ }))
      expect(screen.queryByTestId('board-cell-p_high-opt_todo')).toBeNull()
    })
  })

  it('renders visible fields on cards except the column field, and hides avatars without Assignees', () => {
    const PRIORITY_FIELD: GitHubProjectField = {
      kind: 'single-select',
      id: 'f_priority',
      name: 'Priority',
      dataType: 'SINGLE_SELECT',
      options: [{ id: 'p_high', name: 'High', color: 'RED' }]
    }
    const withAvatar = row('r1', 'Ship it', [
      status('opt_todo', 'Todo'),
      {
        kind: 'single-select',
        fieldId: 'f_priority',
        optionId: 'p_high',
        name: 'High',
        color: 'RED'
      }
    ])
    withAvatar.content.assignees = [{ login: 'ana', name: null, avatarUrl: null }]
    render(
      <ProjectBoard
        sourceTarget={LOCAL_TARGET}
        table={table([TITLE_FIELD, STATUS_FIELD, PRIORITY_FIELD], [withAvatar])}
        fallback={null}
      />
    )
    const card = screen.getByLabelText('#7 — Ship it')
    expect(card.textContent).toContain('High')
    expect(card.textContent).not.toContain('Todo')
    expect(screen.queryByTitle('ana')).toBeNull()
  })
})
