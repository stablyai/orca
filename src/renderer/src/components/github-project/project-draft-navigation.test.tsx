// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { openAppHttpLink } from '@/lib/app-http-link-open'
import type { GitHubProjectTable } from '../../../../shared/github/project-types'
import { normalizeItem } from '../../../../main/github/project-view/project-view-item-normalization'
import ProjectRow from './ProjectRow'
import ProjectBoardCard from './ProjectBoardCard'
import ProjectRoadmapBar from './ProjectRoadmapBar'
import { useProjectRowActions } from './useProjectRowActions'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: { repos: [] }) => unknown) => select({ repos: [] })
}))
vi.mock('@/lib/repo-slug-index', () => ({
  useRepoSlugIndex: () => ({
    lookupSlug: () => [],
    lookupSlugMatches: () => ({ origin: [], upstream: [] }),
    ready: true
  })
}))
vi.mock('@/lib/launch-work-item-direct', () => ({ launchWorkItemDirect: vi.fn() }))
vi.mock('./useProjectRowMutations', () => ({ useProjectRowMutations: () => ({}) }))
vi.mock('@/lib/app-http-link-open', () => ({ openAppHttpLink: vi.fn() }))

afterEach(cleanup)

it('opens the current Project view from draft table, board, roadmap and browser actions', () => {
  const result = normalizeItem(
    {
      id: 'draft',
      type: 'DRAFT_ISSUE',
      content: { __typename: 'DraftIssue', title: 'Draft task' }
    },
    0
  )
  if (!result.ok) {
    throw new Error('Draft normalization failed')
  }
  const row = result.row
  const titleField = { kind: 'field', id: 'title', name: 'Title', dataType: 'TITLE' } as const
  const table: GitHubProjectTable = {
    project: {
      id: 'project',
      owner: 'qa',
      ownerType: 'user',
      number: 1,
      title: 'QA Project',
      url: 'https://github.com/users/qa/projects/1'
    },
    selectedView: {
      id: 'view',
      number: 2,
      name: 'Tasks',
      layout: 'TABLE_LAYOUT',
      filter: '',
      fields: [titleField],
      groupByFields: [],
      sortByFields: []
    },
    rows: [row],
    totalCount: 1,
    parentFieldDropped: false
  }
  function DraftSurfaces() {
    const actions = useProjectRowActions({
      table,
      currentCacheKey: 'project',
      selectedRepoIds: new Set()
    })
    const open = () => actions.openDialog(row)
    return (
      <TooltipProvider>
        <ProjectRow
          row={row}
          fields={[titleField]}
          gridTemplate="1fr auto"
          widths={{}}
          onResizeColumn={vi.fn()}
          editable={false}
          onOpenDialog={open}
          onOpenInBrowser={() => actions.openInBrowser(row)}
          sourceTarget={{ kind: 'local' }}
        />
        <ProjectBoardCard row={row} draggable={false} onOpenDialog={open} onDragStart={vi.fn()} />
        <ProjectRoadmapBar
          row={row}
          span={{ startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2026, 10, 2), point: false }}
          leftPx={0}
          widthPx={100}
          chipColor={null}
          locale="en-US"
          onOpen={open}
        />
      </TooltipProvider>
    )
  }
  render(<DraftSurfaces />)
  const actions = screen.getAllByRole('button')
  expect(actions).toHaveLength(4)
  for (const action of actions) {
    fireEvent.click(action)
  }
  expect(vi.mocked(openAppHttpLink).mock.calls).toEqual(
    Array.from({ length: 4 }, () => ['https://github.com/users/qa/projects/1/views/2'])
  )
  expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull()
})
