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
    }
  }
}

afterEach(cleanup)

describe('ProjectBoard', () => {
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

  it('ignores restricted and unknown payloads and deleted-option drops', () => {
    const onEditField = vi.fn()
    render(
      <ProjectBoard
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
})
