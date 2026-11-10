// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectRoadmap from './ProjectRoadmap'
import { i18n, loadRendererUiLanguage, setRendererPluginLanguagePacks } from '@/i18n/i18n'
import { DEFAULT_LOCALE } from '@/i18n/supported-languages'

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
  await i18n.changeLanguage(await loadRendererUiLanguage(DEFAULT_LOCALE))
})

describe('ProjectRoadmap', () => {
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
})
