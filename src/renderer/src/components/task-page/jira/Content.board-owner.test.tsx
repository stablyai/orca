// @vitest-environment happy-dom

import { useState, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import type { TaskPageJiraBoardView } from '../../task-page-jira-board-view'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { defaultJiraListColumnIds, visibleJiraListColumns } from '../../jira-list-columns'
import { bumpProviderRuntimeSessionGeneration } from '@/lib/provider-runtime-context'
import { TaskPageJiraContent } from './Content'
import type * as I18n from '@/i18n/i18n'

type BoardProps = ComponentProps<typeof TaskPageJiraBoardView>
vi.mock('@/components/task-page-jira-board-view', () => ({
  TaskPageJiraBoardView: ({ target, scopeKey }: BoardProps) => {
    const [draft, setDraft] = useState('')
    return (
      <div>
        <input
          aria-label="Pending board comment"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <output data-testid="board-owner">{JSON.stringify(target)}</output>
        <output data-testid="board-scope">{scopeKey}</output>
      </div>
    )
  }
}))
vi.mock('@/components/JiraIssueWorkspace', () => ({ default: () => null }))
vi.mock('@/components/task-page/linear/Content', () => ({ TaskPageLinearContent: () => null }))
vi.mock('@/components/jira-list-columns-menu', () => ({ JiraListColumnsMenu: () => null }))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'content-owner-project',
  hostId: 'runtime:explicit-jira-owner'
}

function model(sourceContext: TaskSourceContext | null): TaskPageComposerActionsModel {
  const columns = defaultJiraListColumnIds()
  const fixture = {
    jiraStatus: { credentialError: null },
    jiraHasWorkspace: false,
    getJiraIssueWorkspaces: () => [],
    jiraStatusReady: true,
    jiraConnected: true,
    selectedJiraSiteId: 'site-a',
    hideTaskSource: vi.fn(),
    taskSource: 'jira',
    closeTaskDetailPage: vi.fn(),
    selectedJiraIssue: null,
    jiraDetailSourceContext: sourceContext,
    openJiraDetailPage: vi.fn(),
    jiraIssues: [],
    jiraLoading: false,
    jiraError: null,
    jiraErrorDetailsOpen: false,
    setJiraErrorDetailsOpen: vi.fn(),
    jiraJqlRejection: null,
    jiraSearchInput: '',
    jiraOrderBy: 'updated',
    jiraOrderDirection: 'desc',
    handleJiraSort: vi.fn(),
    jiraColumnIds: columns,
    jiraColumns: visibleJiraListColumns(columns),
    toggleJiraColumn: vi.fn(),
    displayedJiraIssues: [],
    displayedJiraStatusOrder: null,
    sortedJiraIssues: [],
    setJiraConnectOpen: vi.fn(),
    handleUseJiraItem: vi.fn(),
    jiraViewMode: 'board',
    setJiraViewMode: vi.fn(),
    jiraCurrentSprint: true,
    setJiraCurrentSprint: vi.fn(),
    jiraTaskSourceContext: sourceContext,
    jiraTaskSourceScopeKey: 'content-source-scope',
    accountBackedTaskSourceHostId: 'runtime:account-jira-owner',
    providerRuntimeContextKey: 'runtime:unrelated-ui-a#0',
    setJiraRefreshNonce: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This presentation fixture supplies every field read by the Jira content branch.
  return fixture as unknown as TaskPageComposerActionsModel
}

it.each([
  { label: 'explicit', sourceContext: source, owner: 'explicit-jira-owner' },
  { label: 'default', sourceContext: null, owner: 'account-jira-owner' }
])(
  'keeps the $label Jira owner draft through unrelated focus and clears it for a new session',
  ({ sourceContext, owner }) => {
    const current = model(sourceContext)
    const { rerender } = render(<TaskPageJiraContent model={current} />)
    expect(screen.getByTestId('board-owner').textContent).toBe(
      JSON.stringify({ kind: 'environment', environmentId: owner })
    )
    const initialScope = screen.getByTestId('board-scope').textContent
    fireEvent.change(screen.getByRole('textbox', { name: 'Pending board comment' }), {
      target: { value: 'Keep this draft' }
    })
    current.providerRuntimeContextKey = 'runtime:unrelated-ui-b#0'
    rerender(<TaskPageJiraContent model={current} />)
    expect(screen.getByDisplayValue('Keep this draft')).toBeDefined()
    expect(screen.getByTestId('board-scope').textContent).toBe(initialScope)

    bumpProviderRuntimeSessionGeneration()
    rerender(<TaskPageJiraContent model={current} />)
    expect(screen.queryByDisplayValue('Keep this draft')).toBeNull()
    expect(screen.getByTestId('board-scope').textContent).not.toBe(initialScope)
    expect(screen.getByTestId('board-owner').textContent).toBe(
      JSON.stringify({ kind: 'environment', environmentId: owner })
    )
  }
)

it('disables sprint filtering in linked mode while retaining its checked preference', () => {
  const current = model(source)
  current.jiraHasWorkspace = true
  const { rerender } = render(<TaskPageJiraContent model={current} />)
  expect(screen.getByRole('switch', { name: 'Current sprint' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('switch', { name: 'Current sprint' }).getAttribute('aria-checked')).toBe(
    'true'
  )
  current.jiraHasWorkspace = false
  rerender(<TaskPageJiraContent model={current} />)
  expect(screen.getByRole('switch', { name: 'Current sprint' }).hasAttribute('disabled')).toBe(
    false
  )
  expect(screen.getByRole('switch', { name: 'Current sprint' }).getAttribute('aria-checked')).toBe(
    'true'
  )
})
