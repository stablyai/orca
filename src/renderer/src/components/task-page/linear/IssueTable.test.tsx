// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPageLinearIssueTable } from './IssueTable'
import type { LinearIssueListRow } from './task-page-linear-issue-model'

vi.mock('./task-page-linear-issue-model', () => ({ LinearStateCell: () => null }))

afterEach(cleanup)

function issue(id: string): LinearIssue {
  return {
    id,
    identifier: `COR-${id}`,
    title: `Issue ${id}`,
    url: `https://linear.app/core/issue/COR-${id}`,
    state: { name: 'Todo', type: 'unstarted', color: '#000' },
    team: { id: 'core', name: 'Core', key: 'COR' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-10-01T00:00:00Z'
  }
}

const first = issue('1')
const second = issue('2')
const third = issue('3')
const rows: LinearIssueListRow[] = [
  { type: 'section', key: 'status:Todo', label: 'Todo', count: 2 },
  { type: 'issue', issue: first },
  { type: 'issue', issue: second },
  { type: 'section', key: 'status:Done', label: 'Done', count: 1 },
  { type: 'issue', issue: third }
]

function table(linearIssueListRows = rows) {
  const fixture = {
    selectedLinearWorkspaceId: 'all',
    linearTaskSourceContext: null,
    selectedLinearIssueId: null,
    openLinearDetailPage: vi.fn(),
    linearIssueAttachmentIndex: new Map(),
    effectiveLinearDisplayProperties: new Set(),
    linearIssueGridStyle: {},
    linearIssueListRows,
    handleOpenOrUseLinearItem: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every model field read by this table.
  const model = fixture as unknown as TaskPageComposerActionsModel
  return (
    <TooltipProvider>
      <TaskPageLinearIssueTable model={model} />
    </TooltipProvider>
  )
}

it('tracks the group key through refreshed rows and leaves ungrouped issues visible', async () => {
  const user = userEvent.setup()
  const view = render(table())
  await user.click(screen.getByRole('button', { name: 'Todo 2' }))
  const refreshed: LinearIssueListRow[] = [
    ...rows.slice(3),
    { type: 'section', key: 'status:Todo', label: 'Todo', count: 3 },
    ...rows.slice(1, 3),
    { type: 'issue', issue: issue('4') }
  ]
  view.rerender(table(refreshed))
  expect(screen.getByRole('button', { name: 'Todo 3', expanded: false })).toBeTruthy()
  expect(screen.queryByText('Issue 4')).toBeNull()
  expect(screen.getByText('Issue 3')).toBeTruthy()

  view.rerender(table([{ type: 'issue', issue: first }]))
  expect(screen.getByText('Issue 1')).toBeTruthy()
  view.unmount()
  render(table())
  expect(screen.getByRole('button', { name: 'Todo 2', expanded: true })).toBeTruthy()
})
