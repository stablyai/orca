// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectRoadmap from './ProjectRoadmap'
import type {
  GitHubProjectField,
  GitHubProjectFieldValue,
  GitHubProjectRow,
  GitHubProjectTable
} from '../../../../shared/github/project-types'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>
}))

const START_FIELD: GitHubProjectField = {
  kind: 'field',
  id: 'f_start',
  name: 'Start date',
  dataType: 'DATE'
}
const TARGET_FIELD: GitHubProjectField = {
  kind: 'field',
  id: 'f_end',
  name: 'Target date',
  dataType: 'DATE'
}
const TITLE_FIELD: GitHubProjectField = {
  kind: 'field',
  id: 'f_title',
  name: 'Title',
  dataType: 'TITLE'
}

function row(id: string, title: string, values: GitHubProjectFieldValue[]): GitHubProjectRow {
  const fieldValuesByFieldId: Record<string, GitHubProjectFieldValue> = {}
  for (const value of values) {
    fieldValuesByFieldId[value.fieldId] = value
  }
  return {
    id,
    itemType: 'ISSUE',
    content: {
      number: 7,
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
    updatedAt: '2026-08-31T00:00:00Z',
    position: 0
  }
}

function table(fields: GitHubProjectField[], rows: GitHubProjectRow[]): GitHubProjectTable {
  return {
    project: {
      id: 'PVT_1',
      owner: 'stablyai',
      ownerType: 'organization',
      number: 3,
      title: 'Orca',
      url: 'https://github.com/orgs/stablyai/projects/3'
    },
    selectedView: {
      id: 'PVTV_1',
      number: 2,
      name: 'Roadmap',
      layout: 'ROADMAP_LAYOUT',
      filter: '',
      fields,
      groupByFields: [],
      sortByFields: []
    },
    rows,
    totalCount: rows.length,
    parentFieldDropped: false
  }
}

afterEach(cleanup)

describe('ProjectRoadmap', () => {
  it('places a dated row on the timeline and names the fields driving it', () => {
    render(
      <ProjectRoadmap
        table={table(
          [TITLE_FIELD, START_FIELD, TARGET_FIELD],
          [
            row('PVTI_1', 'Ship the thing', [
              { kind: 'date', fieldId: 'f_start', date: '2026-03-02' },
              { kind: 'date', fieldId: 'f_end', date: '2026-03-20' }
            ])
          ]
        )}
        fallback={<div>list</div>}
      />
    )
    expect(screen.getByText('Placed by Start date → Target date')).toBeTruthy()
    expect(screen.getByLabelText(/^Ship the thing — /)).toBeTruthy()
    expect(screen.queryByText('list')).toBeNull()
  })

  it('keeps an undated row in place and flags it rather than hiding it', () => {
    render(
      <ProjectRoadmap
        table={table(
          [TITLE_FIELD, START_FIELD, TARGET_FIELD],
          [
            row('PVTI_1', 'Dated', [{ kind: 'date', fieldId: 'f_start', date: '2026-03-02' }]),
            row('PVTI_2', 'Undated', [])
          ]
        )}
        fallback={<div>list</div>}
      />
    )
    expect(screen.getByText('No dates')).toBeTruthy()
    expect(screen.getByText('1 without dates')).toBeTruthy()
    expect(screen.queryByLabelText(/^Undated — /)).toBeNull()
  })

  it('opens the row dialog when a bar is clicked', () => {
    const onOpenDialog = vi.fn()
    render(
      <ProjectRoadmap
        table={table(
          [TITLE_FIELD, START_FIELD, TARGET_FIELD],
          [
            row('PVTI_1', 'Ship the thing', [
              { kind: 'date', fieldId: 'f_start', date: '2026-03-02' },
              { kind: 'date', fieldId: 'f_end', date: '2026-03-20' }
            ])
          ]
        )}
        onOpenDialog={onOpenDialog}
        fallback={<div>list</div>}
      />
    )
    fireEvent.click(screen.getByLabelText(/^Ship the thing — /))
    expect(onOpenDialog).toHaveBeenCalledTimes(1)
    expect(onOpenDialog.mock.calls[0]?.[0]).toMatchObject({ id: 'PVTI_1' })
  })

  it('places items from row-carried dates when the view hides its date fields', () => {
    render(
      <ProjectRoadmap
        table={table(
          [TITLE_FIELD],
          [
            row('PVTI_1', 'Hidden-field item', [
              { kind: 'date', fieldId: 'f_start', date: '2026-03-02', fieldName: 'Start date' },
              { kind: 'date', fieldId: 'f_end', date: '2026-03-20', fieldName: 'Target date' }
            ])
          ]
        )}
        fallback={<div>list</div>}
      />
    )
    expect(screen.getByText('Placed by Start date → Target date')).toBeTruthy()
    expect(screen.getByLabelText(/^Hidden-field item — /)).toBeTruthy()
    expect(screen.queryByText('list')).toBeNull()
  })

  it('announces restricted items by name in the bar label', () => {
    const redacted: GitHubProjectRow = {
      ...row('PVTI_9', '', [
        { kind: 'date', fieldId: 'f_start', date: '2026-03-02' },
        { kind: 'date', fieldId: 'f_end', date: '2026-03-05' }
      ]),
      itemType: 'REDACTED'
    }
    render(
      <ProjectRoadmap
        table={table([TITLE_FIELD, START_FIELD, TARGET_FIELD], [redacted])}
        fallback={<div>list</div>}
      />
    )
    expect(screen.getByLabelText(/^Restricted item — /)).toBeTruthy()
  })

  it('falls back to the caller-supplied list when no field can place items', () => {
    render(<ProjectRoadmap table={table([TITLE_FIELD], [])} fallback={<div>list</div>} />)
    expect(screen.getByText('list')).toBeTruthy()
    expect(
      screen.getByText(
        'This roadmap view has no date or iteration field to place items on, so Orca is listing them instead.'
      )
    ).toBeTruthy()
  })

  it('reports an empty filter result instead of drawing an empty grid', () => {
    render(
      <ProjectRoadmap
        table={table([TITLE_FIELD, START_FIELD, TARGET_FIELD], [])}
        fallback={<div>list</div>}
      />
    )
    expect(screen.getByText("No items match this view's filter.")).toBeTruthy()
    expect(screen.queryByText('list')).toBeNull()
  })
})
