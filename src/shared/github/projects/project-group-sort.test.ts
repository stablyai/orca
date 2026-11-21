import { describe, expect, it } from 'vitest'
import type {
  GitHubProjectField,
  GitHubProjectRow,
  GitHubProjectSort,
  GitHubProjectTable,
  GitHubProjectView
} from './project-types'
import { sortRows, groupRows } from './project-group-sort'

function makeRow(
  id: string,
  position: number,
  values: GitHubProjectRow['fieldValuesByFieldId']
): GitHubProjectRow {
  return {
    id,
    itemType: 'ISSUE',
    content: {
      number: 1,
      title: id,
      body: null,
      url: null,
      state: 'open',
      stateReason: null,
      isDraft: null,
      repository: 'acme/repo',
      assignees: [],
      labels: [],
      parentIssue: null,
      issueType: null
    },
    fieldValuesByFieldId: values,
    updatedAt: '2026-01-01T00:00:00Z',
    position
  }
}

function makeView(field: GitHubProjectField, sort: GitHubProjectSort): GitHubProjectView {
  return {
    id: 'V_1',
    number: 1,
    name: 'Default',
    layout: 'TABLE_LAYOUT',
    filter: '',
    fields: [field],
    groupByFields: [field],
    sortByFields: [sort]
  }
}

function makeTable(view: GitHubProjectView, rows: GitHubProjectRow[]): GitHubProjectTable {
  return {
    project: {
      id: 'P',
      owner: 'acme',
      ownerType: 'organization',
      number: 1,
      title: 'P',
      url: ''
    },
    selectedView: view,
    rows,
    totalCount: rows.length,
    parentFieldDropped: false
  }
}

describe('blank selection field values', () => {
  it.each<{
    field: GitHubProjectField
    blank: GitHubProjectRow['fieldValuesByFieldId'][string]
    populated: GitHubProjectRow['fieldValuesByFieldId'][string]
  }>([
    {
      field: {
        kind: 'single-select',
        id: 'F_status',
        name: 'Status',
        dataType: 'SINGLE_SELECT',
        options: [{ id: 'opt_a', name: 'Todo', color: 'GRAY' }]
      },
      blank: {
        kind: 'single-select',
        fieldId: 'F_status',
        optionId: 'opt_a',
        name: ' ',
        color: 'GRAY'
      },
      populated: {
        kind: 'single-select',
        fieldId: 'F_status',
        optionId: 'opt_a',
        name: 'Todo',
        color: 'GRAY'
      }
    },
    {
      field: {
        kind: 'iteration',
        id: 'F_iteration',
        name: 'Iteration',
        dataType: 'ITERATION',
        iterations: []
      },
      blank: {
        kind: 'iteration',
        fieldId: 'F_iteration',
        iterationId: 'iter_1',
        title: ' ',
        startDate: '2026-01-01',
        duration: 14
      },
      populated: {
        kind: 'iteration',
        fieldId: 'F_iteration',
        iterationId: 'iter_1',
        title: 'Sprint 1',
        startDate: '2026-01-01',
        duration: 14
      }
    }
  ])(
    'groups blank $field.kind with missing values and sorts both last',
    ({ field, blank, populated }) => {
      const rows = [
        makeRow('blank', 0, { [field.id]: blank }),
        makeRow('populated', 1, { [field.id]: populated }),
        makeRow('missing', 2, {})
      ]
      for (const direction of ['ASC', 'DESC'] as const) {
        const table = makeTable(makeView(field, { field, direction }), rows)
        expect(sortRows(table, rows).map((row) => row.id)).toEqual([
          'populated',
          'blank',
          'missing'
        ])
        expect(
          groupRows(table, rows)
            .at(-1)
            ?.rows.map((row) => row.id)
        ).toEqual(['blank', 'missing'])
      }
    }
  )
})
