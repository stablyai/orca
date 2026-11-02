// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPageJiraIssueList } from './task-page-jira-issue-list'
import { defaultJiraListColumnIds, visibleJiraListColumns } from './jira-list-columns'
import type { JiraIssue } from '../../../shared/jira-types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  siteId: 'site-a',
  title: 'Fix login',
  url: 'https://acme.atlassian.net/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: {
    id: '1',
    name: 'In Progress',
    categoryKey: 'indeterminate',
    categoryName: 'In Progress'
  },
  labels: [],
  createdAt: '2026-10-01',
  updatedAt: '2026-10-01'
}
const first = makeWorktree({ id: 'first', repoId: 'api', displayName: 'API fix' })
const second = makeWorktree({ id: 'second', repoId: 'web', displayName: 'UI fix' })
// The row receives a scoped lookup so the UI cannot accidentally match bare keys.
const onOpenWorkspace = vi.fn()
const onOpenIssue = vi.fn()
const onStartWorkspace = vi.fn()
function renderList(workspaces = [first, second]) {
  const props = {
    columns: visibleJiraListColumns(defaultJiraListColumnIds()),
    issues: [issue],
    selectedIssue: null,
    showSiteContext: false,
    statusOrder: null,
    formatUpdatedAt: () => 'Today',
    getStatusTone: () => '',
    onOpenIssue,
    onStartWorkspace,
    getIssueWorkspaces: () => workspaces,
    onOpenWorkspace
  }
  return render(
    <TooltipProvider>
      <TaskPageJiraIssueList {...props} />
    </TooltipProvider>
  )
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
describe('Jira linked workspace actions', () => {
  it('shows all linked workspaces and opens the selected one', async () => {
    renderList()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '2 workspaces linked to APP-1' }))
    await user.click(await screen.findByRole('menuitem', { name: /UI fix/ }))
    expect(onOpenWorkspace).toHaveBeenCalledWith(second)
  })
  it('offers existing and new workspaces when exactly one is linked', async () => {
    renderList([first])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '1 workspace linked to APP-1' }))
    expect(onOpenWorkspace).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: /API fix/ })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Start new workspace' }))
    expect(onStartWorkspace).toHaveBeenCalledWith(issue)
    expect(onOpenIssue).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '1 workspace linked to APP-1' }))
    await user.click(screen.getByRole('menuitem', { name: /API fix/ }))
    expect(onOpenWorkspace).toHaveBeenCalledWith(first)
  })
  it('keeps the new-workspace action for an unlinked issue', () => {
    renderList([])
    expect(screen.getByRole('button', { name: 'Start workspace from APP-1' })).toBeInTheDocument()
  })
})
