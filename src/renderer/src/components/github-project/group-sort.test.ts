// Why: cover the bug fixes from the recent review — particularly the NaN
// sort produced when two rows reference unknown single-select option IDs or
// unknown iteration IDs, and the empty-group ordering invariant.
import { describe, expect, it } from 'vitest'
import type {
  GitHubProjectField,
  GitHubProjectRow,
  GitHubProjectSort,
  GitHubProjectTable,
  GitHubProjectView
} from '../../../../shared/github/project-types'
import { sortRows, groupRows } from '../../../../shared/github/project-group-sort'

const singleSelectField: GitHubProjectField = {
  kind: 'single-select',
  id: 'F_status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'opt_a', name: 'Todo', color: 'GRAY' },
    { id: 'opt_b', name: 'In Progress', color: 'YELLOW' }
  ]
}

const iterationField: GitHubProjectField = {
  kind: 'iteration',
  id: 'F_iter',
  name: 'Iteration',
  dataType: 'ITERATION',
  iterations: [
    { id: 'iter_1', title: 'Sprint 1', startDate: '2026-01-01', duration: 14, completed: false },
    { id: 'iter_2', title: 'Sprint 2', startDate: '2026-01-15', duration: 14, completed: false }
  ]
}

const assigneesField: GitHubProjectField = {
  kind: 'field',
  id: 'F_assignees',
  name: 'Assignees',
  dataType: 'ASSIGNEES'
}

const labelsField: GitHubProjectField = {
  kind: 'field',
  id: 'F_labels',
  name: 'Labels',
  dataType: 'LABELS'
}

const textField: GitHubProjectField = {
  kind: 'field',
  id: 'F_text',
  name: 'Notes',
  dataType: 'TEXT'
}

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

function makeView(field: GitHubProjectField, sort?: GitHubProjectSort): GitHubProjectView {
  return {
    id: 'V_1',
    number: 1,
    name: 'Default',
    layout: 'TABLE_LAYOUT',
    filter: '',
    fields: [field],
    groupByFields: [],
    sortByFields: sort ? [sort] : []
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

describe('sortRows', () => {
  it('orders rows by single-select option order', () => {
    const view = makeView(singleSelectField, {
      direction: 'ASC',
      field: singleSelectField
    })
    const rows = [
      makeRow('r2', 1, {
        F_status: {
          kind: 'single-select',
          fieldId: 'F_status',
          optionId: 'opt_b',
          name: 'In Progress',
          color: 'YELLOW'
        }
      }),
      makeRow('r1', 0, {
        F_status: {
          kind: 'single-select',
          fieldId: 'F_status',
          optionId: 'opt_a',
          name: 'Todo',
          color: 'GRAY'
        }
      })
    ]
    const sorted = sortRows(makeTable(view, rows), rows)
    expect(sorted.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('does not produce NaN when both rows reference unknown single-select options', () => {
    // Why: this was the bug — `Infinity - Infinity = NaN` made sort()'s
    // behavior implementation-defined and skipped the row.position
    // tie-break. Two orphaned rows must still fall through to position.
    const view = makeView(singleSelectField, {
      direction: 'ASC',
      field: singleSelectField
    })
    const rows = [
      makeRow('rB', 5, {
        F_status: {
          kind: 'single-select',
          fieldId: 'F_status',
          optionId: 'orphan_2',
          name: 'Gone',
          color: 'GRAY'
        }
      }),
      makeRow('rA', 1, {
        F_status: {
          kind: 'single-select',
          fieldId: 'F_status',
          optionId: 'orphan_1',
          name: 'Gone',
          color: 'GRAY'
        }
      })
    ]
    const sorted = sortRows(makeTable(view, rows), rows)
    // After tie-break by position, rA (position=1) precedes rB (position=5).
    expect(sorted.map((r) => r.id)).toEqual(['rA', 'rB'])
  })

  it('does not produce NaN when both rows reference unknown iteration ids', () => {
    const view = makeView(iterationField, {
      direction: 'ASC',
      field: iterationField
    })
    const rows = [
      makeRow('rB', 5, {
        F_iter: {
          kind: 'iteration',
          fieldId: 'F_iter',
          iterationId: 'gone_b',
          title: 'Gone B',
          startDate: '2025-01-01',
          duration: 14
        }
      }),
      makeRow('rA', 1, {
        F_iter: {
          kind: 'iteration',
          fieldId: 'F_iter',
          iterationId: 'gone_a',
          title: 'Gone A',
          startDate: '2025-01-01',
          duration: 14
        }
      })
    ]
    const sorted = sortRows(makeTable(view, rows), rows)
    expect(sorted.map((r) => r.id)).toEqual(['rA', 'rB'])
  })

  it('places rows missing the sort field after rows that have it', () => {
    const view = makeView(singleSelectField, {
      direction: 'ASC',
      field: singleSelectField
    })
    const rows = [
      makeRow('rEmpty', 0, {}),
      makeRow('rHas', 1, {
        F_status: {
          kind: 'single-select',
          fieldId: 'F_status',
          optionId: 'opt_a',
          name: 'Todo',
          color: 'GRAY'
        }
      })
    ]
    const sorted = sortRows(makeTable(view, rows), rows)
    expect(sorted.map((r) => r.id)).toEqual(['rHas', 'rEmpty'])
  })

  it('sorts an empty user list last in both directions, like a missing value', () => {
    // Why: the DESC flip negated the empty branch, sending unassigned rows to the top.
    const rows = [
      makeRow('empty-list', 0, {
        F_assignees: { kind: 'users', fieldId: 'F_assignees', users: [] }
      }),
      makeRow('alice', 1, {
        F_assignees: {
          kind: 'users',
          fieldId: 'F_assignees',
          users: [{ login: 'alice', name: null, avatarUrl: null }]
        }
      }),
      makeRow('no-value', 2, {})
    ]

    for (const direction of ['ASC', 'DESC'] as const) {
      const view = makeView(assigneesField, { direction, field: assigneesField })
      const sorted = sortRows(makeTable(view, rows), rows)
      expect(sorted.map((r) => r.id)).toEqual(['alice', 'empty-list', 'no-value'])
    }
  })

  it('sorts an empty label list last in both directions, like a missing value', () => {
    const rows = [
      makeRow('empty-list', 0, {
        F_labels: { kind: 'labels', fieldId: 'F_labels', labels: [] }
      }),
      makeRow('bug', 1, {
        F_labels: {
          kind: 'labels',
          fieldId: 'F_labels',
          labels: [{ name: 'bug', color: 'ff0000' }]
        }
      }),
      makeRow('no-value', 2, {})
    ]

    for (const direction of ['ASC', 'DESC'] as const) {
      const view = makeView(labelsField, { direction, field: labelsField })
      const sorted = sortRows(makeTable(view, rows), rows)
      expect(sorted.map((r) => r.id)).toEqual(['bug', 'empty-list', 'no-value'])
    }
  })

  it('sorts a blank text value last in both directions, like a missing value', () => {
    // Why reachable: the normalizer turns a null GitHub text/date into ''.
    const rows = [
      makeRow('blank', 0, { F_text: { kind: 'text', fieldId: 'F_text', text: '' } }),
      makeRow('alpha', 1, { F_text: { kind: 'text', fieldId: 'F_text', text: 'alpha' } }),
      makeRow('no-value', 2, {})
    ]

    for (const direction of ['ASC', 'DESC'] as const) {
      const view = makeView(textField, { direction, field: textField })
      const sorted = sortRows(makeTable(view, rows), rows)
      expect(sorted.map((r) => r.id)).toEqual(['alpha', 'blank', 'no-value'])
    }
  })

  it('keeps sort fallback finite when row positions are absent', () => {
    const view = makeView(singleSelectField)
    const rows = [
      { ...makeRow('rA', 0, {}), position: undefined as unknown as number },
      { ...makeRow('rB', 0, {}), position: undefined as unknown as number }
    ]

    const sorted = sortRows(makeTable(view, rows), rows)

    expect(sorted.map((r) => r.id)).toEqual(['rA', 'rB'])
  })
})

describe('groupRows', () => {
  it('groups a present-but-empty user list with the missing-value rows', () => {
    // Why: an empty list fell through to a blank-label group, which renders as "All".
    const view = { ...makeView(assigneesField), groupByFields: [assigneesField] }
    const rows = [
      makeRow('empty-list', 0, {
        F_assignees: { kind: 'users', fieldId: 'F_assignees', users: [] }
      }),
      makeRow('alice', 1, {
        F_assignees: {
          kind: 'users',
          fieldId: 'F_assignees',
          users: [{ login: 'alice', name: null, avatarUrl: null }]
        }
      }),
      makeRow('no-value', 2, {})
    ]

    const groups = groupRows(makeTable(view, rows), rows)

    expect(groups.map((group) => [group.label, group.rows.map((r) => r.id)])).toEqual([
      ['alice', ['alice']],
      ['No Assignees', ['empty-list', 'no-value']]
    ])
  })

  it('places the empty group last', () => {
    const view = {
      ...makeView(singleSelectField),
      groupByFields: [singleSelectField]
    }
    const rows = [
      makeRow('rNone', 0, {}),
      makeRow('rA', 1, {
        F_status: {
          kind: 'single-select',
          fieldId: 'F_status',
          optionId: 'opt_a',
          name: 'Todo',
          color: 'GRAY'
        }
      })
    ]
    const groups = groupRows(makeTable(view, rows), rows)
    expect(groups.map((g) => g.key)).toEqual(['opt_a', '__empty__'])
  })
})
