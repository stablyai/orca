// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectRoadmap from './ProjectRoadmap'
import { i18n, setRendererPluginLanguagePacks, setRendererUiLanguage } from '@/i18n/i18n'
import { DEFAULT_LOCALE } from '@/i18n/supported-languages'
import { pluginLanguageResourceId } from '../../../../shared/plugins/plugin-language-pack-artifact'
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

function table(
  fields: GitHubProjectField[],
  rows: GitHubProjectRow[],
  filter = ''
): GitHubProjectTable {
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
      filter,
      fields,
      groupByFields: [],
      sortByFields: []
    },
    rows,
    totalCount: rows.length,
    parentFieldDropped: false
  }
}

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  window.localStorage.clear()
  setRendererPluginLanguagePacks([])
  await setRendererUiLanguage(DEFAULT_LOCALE)
})

describe('ProjectRoadmap', () => {
  it.each([
    ['pt-BR', 'pt-BR'],
    ['en-US-US', DEFAULT_LOCALE]
  ])('renders date ticks and bars with plugin locale %s', async (packLocale, dateLocale) => {
    const packId = 'plugin:stablyai.orca-portuguese/pt-BR' as const
    const resourceLanguage = pluginLanguageResourceId(packId)
    // The resource tag recorded in the Windows crash report on #25021.
    expect(resourceLanguage).toBe(
      'plugin0070006c007500670069006e003a0073007400610062006c007900610069002e006f007200630061002d0070006f00720074007500670075006500730065002f00700074002d00420052'
    )
    setRendererPluginLanguagePacks([
      {
        id: packId,
        resourceLanguage,
        pluginKey: 'stablyai.orca-portuguese',
        locale: packLocale,
        catalog: { common: { cancel: 'Cancelar' } }
      }
    ])
    await setRendererUiLanguage(packId)
    expect(i18n.resolvedLanguage).toBe(resourceLanguage)

    render(
      <ProjectRoadmap
        table={table(
          [TITLE_FIELD, START_FIELD, TARGET_FIELD],
          [
            row('scheduled', 'Scheduled', [
              { kind: 'date', fieldId: START_FIELD.id, date: '2026-09-01' },
              { kind: 'date', fieldId: TARGET_FIELD.id, date: '2026-10-15' }
            ])
          ]
        )}
        fallback={<div>list</div>}
      />
    )

    const month = new Intl.DateTimeFormat(dateLocale, {
      month: 'short',
      timeZone: 'UTC'
    }).format(new Date(Date.UTC(2026, 8, 1)))
    expect(screen.getAllByText(month, { exact: false }).length).toBeGreaterThan(0)
    const dateFormat = new Intl.DateTimeFormat(dateLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC'
    })
    const start = dateFormat.format(new Date(Date.UTC(2026, 8, 1)))
    const end = dateFormat.format(new Date(Date.UTC(2026, 9, 15)))
    expect(screen.getByRole('button', { name: `Scheduled — ${start} – ${end}` })).toBeTruthy()
  })

  it('moves the today marker across local midnight without resetting scroll and cleans up its timer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 5, 23, 59, 59))
    const { unmount } = render(
      <ProjectRoadmap
        table={table(
          [START_FIELD, TARGET_FIELD],
          [row('one', 'Scheduled', [{ kind: 'date', fieldId: 'f_start', date: '2026-09-01' }])]
        )}
        fallback={<div>list</div>}
      />
    )
    const scroller = screen.getByTestId('project-roadmap-scroller')
    const marker = scroller.querySelector<HTMLElement>('.sticky.top-0 .absolute')!
    const before = Number.parseFloat(marker.style.left)
    scroller.scrollLeft = 123
    act(() => vi.advanceTimersByTime(2100))
    expect(Number.parseFloat(marker.style.left) - before).toBeCloseTo(148 / 30)
    expect(scroller.scrollLeft).toBe(123)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])(
    'centers when an initially empty view gains dated rows (fields hidden: %s)',
    (hidden) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 8, 5, 12))
      const fields = hidden ? [TITLE_FIELD] : [TITLE_FIELD, START_FIELD, TARGET_FIELD]
      const { rerender } = render(
        <ProjectRoadmap table={table(fields, [])} fallback={<div>list</div>} />
      )
      const populated = table(fields, [
        row('one', 'Arrived', [
          { kind: 'date', fieldId: 'f_start', date: '2026-01-01' },
          { kind: 'date', fieldId: 'f_end', date: '2026-09-10' }
        ])
      ])
      rerender(<ProjectRoadmap table={populated} fallback={<div>list</div>} />)
      const scroller = screen.getByTestId('project-roadmap-scroller')
      expect(scroller.scrollLeft).toBeGreaterThan(1000)
      scroller.scrollLeft = 123
      rerender(
        <ProjectRoadmap
          table={{ ...populated, rows: [...populated.rows] }}
          fallback={<div>list</div>}
        />
      )
      expect(scroller.scrollLeft).toBe(123)
      fireEvent.click(screen.getByRole('button', { name: 'Year' }))
      expect(scroller.scrollLeft).not.toBe(123)
      expect(window.localStorage.getItem('orca.githubProject.roadmapZoom')).toBe('year')
    }
  )

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
        table={table([TITLE_FIELD, START_FIELD, TARGET_FIELD], [], 'status:Todo')}
        fallback={<div>list</div>}
      />
    )
    expect(screen.getByText("No items match this view's filter.")).toBeTruthy()
    expect(screen.queryByText('list')).toBeNull()
  })

  it('does not blame a filter an unfiltered roadmap does not have', () => {
    render(
      <ProjectRoadmap
        table={table([TITLE_FIELD, START_FIELD, TARGET_FIELD], [])}
        fallback={<div>list</div>}
      />
    )
    expect(screen.getByText('This view has no items yet.')).toBeTruthy()
    expect(screen.queryByText("No items match this view's filter.")).toBeNull()
  })
})
