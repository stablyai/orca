// @vitest-environment happy-dom
//
// Why: Phase 3 — hierarchy (tree) mode for TABLE_LAYOUT views. Covers the
// off-by-default regression guard, nesting/indent via data-depth, per-row
// collapse/expand, per-view persistence, and per-group tree composition
// (a child grouped apart from its parent stays an unindented root).
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubProjectField,
  GitHubProjectRow,
  GitHubProjectTable,
  GitHubProjectView
} from '../../../../shared/github-project-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import ProjectViewList from './ProjectViewList'

// Why: ProjectRow's hover actions use radix Tooltip, which requires an
// ancestor TooltipProvider (the app shell provides it in production).
function renderList(table: GitHubProjectTable): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <ProjectViewList table={table} sourceSettings={null} />
    </TooltipProvider>
  )
}

const titleField: GitHubProjectField = {
  kind: 'field',
  id: 'F_title',
  name: 'Title',
  dataType: 'TITLE'
}

const statusField: GitHubProjectField = {
  kind: 'single-select',
  id: 'F_status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'opt_todo', name: 'Todo', color: 'GRAY' },
    { id: 'opt_progress', name: 'In Progress', color: 'YELLOW' }
  ]
}

function makeRow(
  id: string,
  position: number,
  options: {
    url?: string | null
    parentUrl?: string | null
    values?: GitHubProjectRow['fieldValuesByFieldId']
  } = {}
): GitHubProjectRow {
  const { url = null, parentUrl = null, values = {} } = options
  return {
    id,
    itemType: 'ISSUE',
    content: {
      number: position + 1,
      title: id,
      body: null,
      url,
      state: 'open',
      stateReason: null,
      isDraft: null,
      repository: 'acme/repo',
      assignees: [],
      labels: [],
      parentIssue: parentUrl ? { number: 999, title: 'parent', url: parentUrl } : null,
      issueType: null,
      subIssuesSummary: null,
      trackedIssues: [],
      trackedInIssues: []
    },
    fieldValuesByFieldId: values,
    updatedAt: '2026-01-01T00:00:00Z',
    position
  }
}

function makeView(overrides: Partial<GitHubProjectView> = {}): GitHubProjectView {
  return {
    id: 'V_1',
    number: 1,
    name: 'Default',
    layout: 'TABLE_LAYOUT',
    filter: '',
    fields: [titleField],
    groupByFields: [],
    sortByFields: [],
    ...overrides
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

const URL_A = 'https://github.com/acme/repo/issues/1'
const URL_B = 'https://github.com/acme/repo/issues/2'
const URL_C = 'https://github.com/acme/repo/issues/3'
const URL_D = 'https://github.com/acme/repo/issues/4'
const URL_E = 'https://github.com/acme/repo/issues/5'

// Epic ─┬─ StoryOne ── TaskOne
//       └─ StoryTwo
// Loner is an unrelated root.
function makeHierarchyTable(): GitHubProjectTable {
  return makeTable(makeView(), [
    makeRow('Epic', 0, { url: URL_A }),
    makeRow('StoryOne', 1, { url: URL_B, parentUrl: URL_A }),
    makeRow('StoryTwo', 2, { url: URL_C, parentUrl: URL_A }),
    makeRow('TaskOne', 3, { url: URL_D, parentUrl: URL_B }),
    makeRow('Loner', 4, { url: URL_E })
  ])
}

const FIXTURE_TITLES = ['Epic', 'StoryOne', 'StoryTwo', 'TaskOne', 'Loner']

function rowElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('div[class*="group/project-row"]'))
}

function rowTitles(container: HTMLElement): string[] {
  return rowElements(container).map((el) => {
    const text = el.textContent ?? ''
    return FIXTURE_TITLES.find((title) => text.includes(title)) ?? text
  })
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => map.delete(key),
    setItem: (key, value) => map.set(key, value)
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
  vi.stubGlobal('api', {
    shell: {
      openUrl: vi.fn().mockResolvedValue(undefined)
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ProjectViewList — hierarchy mode', () => {
  it('renders the toggle off by default with the flat row list unchanged', () => {
    const { container } = renderList(makeHierarchyTable())
    const toggle = screen.getByLabelText('Show hierarchy')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(rowTitles(container)).toEqual(['Epic', 'StoryOne', 'StoryTwo', 'TaskOne', 'Loner'])
    // Regression guard: no tree affordances leak into the flat path.
    expect(container.querySelector('[data-depth]')).toBeNull()
    expect(screen.queryByLabelText('Collapse sub-issues')).toBeNull()
    expect(screen.queryByLabelText('Expand sub-issues')).toBeNull()
  })

  it('nests rows beneath their parents with chevrons and increasing depth when toggled on', () => {
    const { container } = renderList(makeHierarchyTable())
    fireEvent.click(screen.getByLabelText('Show hierarchy'))
    expect(screen.getByLabelText('Show hierarchy')).toHaveAttribute('aria-pressed', 'true')
    // Children render directly beneath their parent, not in flat order.
    expect(rowTitles(container)).toEqual(['Epic', 'StoryOne', 'TaskOne', 'StoryTwo', 'Loner'])
    const depths = rowElements(container).map((el) => el.getAttribute('data-depth'))
    expect(depths).toEqual(['0', '1', '2', '1', '0'])
    // Epic and StoryOne have children → two expanded chevrons.
    expect(screen.getAllByLabelText('Collapse sub-issues')).toHaveLength(2)
  })

  it('collapses and re-expands a parent subtree via its chevron', () => {
    const { container } = renderList(makeHierarchyTable())
    fireEvent.click(screen.getByLabelText('Show hierarchy'))
    // First chevron in document order belongs to Epic (the top-level parent).
    fireEvent.click(screen.getAllByLabelText('Collapse sub-issues')[0])
    expect(rowTitles(container)).toEqual(['Epic', 'Loner'])
    fireEvent.click(screen.getByLabelText('Expand sub-issues'))
    expect(rowTitles(container)).toEqual(['Epic', 'StoryOne', 'TaskOne', 'StoryTwo', 'Loner'])
  })

  it('keeps an unrelated root row unindented and last with hierarchy mode on', () => {
    const { container } = renderList(makeHierarchyTable())
    fireEvent.click(screen.getByLabelText('Show hierarchy'))
    const rows = rowElements(container)
    const loner = rows.at(-1)
    if (!loner) {
      throw new Error('expected at least one rendered row')
    }
    expect(loner.textContent).toContain('Loner')
    expect(loner.getAttribute('data-depth')).toBe('0')
    // No chevron inside a childless root — only the footprint spacer. The
    // synthetic Type column's popover trigger also carries aria-expanded, so
    // match the chevron by its accessible label.
    expect(
      loner.querySelector(
        'button[aria-label="Expand sub-issues"], button[aria-label="Collapse sub-issues"]'
      )
    ).toBeNull()
  })

  it('persists hierarchy mode per view across unmount/remount', () => {
    const first = renderList(makeHierarchyTable())
    fireEvent.click(screen.getByLabelText('Show hierarchy'))
    expect(screen.getByLabelText('Show hierarchy')).toHaveAttribute('aria-pressed', 'true')
    first.unmount()

    renderList(makeHierarchyTable())
    expect(screen.getByLabelText('Show hierarchy')).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders a cross-group child as an unindented root inside its own group', () => {
    const view = makeView({
      id: 'V_grouped',
      fields: [titleField, statusField],
      groupByFields: [statusField]
    })
    const table = makeTable(view, [
      makeRow('Epic', 0, {
        url: URL_A,
        values: {
          [statusField.id]: {
            kind: 'single-select',
            fieldId: statusField.id,
            optionId: 'opt_todo',
            name: 'Todo',
            color: 'GRAY'
          }
        }
      }),
      makeRow('StoryOne', 1, {
        url: URL_B,
        parentUrl: URL_A,
        values: {
          [statusField.id]: {
            kind: 'single-select',
            fieldId: statusField.id,
            optionId: 'opt_progress',
            name: 'In Progress',
            color: 'YELLOW'
          }
        }
      })
    ])
    const { container } = renderList(table)
    fireEvent.click(screen.getByLabelText('Show hierarchy'))
    // Two group buckets, each with a single depth-0 row: the parent cannot
    // reach across group boundaries to claim its child.
    const depths = rowElements(container).map((el) => el.getAttribute('data-depth'))
    expect(depths).toEqual(['0', '0'])
    expect(screen.queryByLabelText('Collapse sub-issues')).toBeNull()
    expect(screen.queryByLabelText('Expand sub-issues')).toBeNull()
  })
})
