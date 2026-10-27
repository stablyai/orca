// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskPageJiraIssueDialog } from './IssueDialog'
import { useTaskPageJiraIssueCreation } from '../../use-task-page-jira-issue-creation'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import type { JiraCreateField } from '../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

const { search, create, getIssue } = vi.hoisted(() => ({
  search: vi.fn(),
  create: vi.fn(),
  getIssue: vi.fn()
}))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraSearchUsers: search,
  jiraCreateIssue: create,
  jiraGetIssue: getIssue
}))
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  create.mockResolvedValue({ ok: true, key: 'APP-1' })
  getIssue.mockResolvedValue(null)
})

const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'folder-project',
  hostId: 'local'
}
const reporter: JiraCreateField = {
  key: 'reporter',
  name: 'Reporter',
  required: true,
  schema: { type: 'user' }
}

function CreateDialog({ field = reporter }: { field?: JiraCreateField }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const model = {
    settings: null,
    providerRuntimeContextKey: 'local',
    providerRuntimeContextKeyRef: useRef('local'),
    jiraTaskSourceContext: source,
    newJiraIssueOpen: open,
    setNewJiraIssueOpen: setOpen,
    newJiraIssueTitle: 'Fix reporter selection',
    setNewJiraIssueTitle: vi.fn(),
    handleNewJiraIssueTitleChange: vi.fn(),
    newJiraIssueSummaryAvailable: false,
    newJiraIssueSummaryGenerating: false,
    newJiraIssueSummaryError: null,
    handleGenerateNewJiraIssueSummary: vi.fn(),
    handleCancelNewJiraIssueSummaryGeneration: vi.fn(),
    newJiraIssueBody: '',
    setNewJiraIssueBody: vi.fn(),
    newJiraIssueSubmitting: submitting,
    setNewJiraIssueSubmitting: setSubmitting,
    newJiraIssueProjectComboboxOpen: false,
    newJiraIssueProjectQuery: '',
    newJiraIssueProjectCommandValue: '',
    newJiraIssueTypeId: 'bug',
    setNewJiraIssueTypeId: vi.fn(),
    availableJiraIssueTypes: [{ id: 'bug', name: 'Bug' }],
    jiraIssueTypesLoading: false,
    jiraCreateFields: [field],
    jiraCreateFieldsLoading: false,
    jiraCreateFieldsError: null,
    visibleJiraCreateFields: [field],
    newJiraIssueCustomFieldValues: values,
    setNewJiraIssueCustomFieldValues: setValues,
    hasMissingJiraCreateField: !(values[field.key] ?? '').trim(),
    sortedAvailableJiraProjects: [],
    filteredNewJiraIssueProjects: [],
    includeJiraSiteNameInProjectLabel: false,
    newJiraIssueTargetProject: { id: '100', key: 'APP', name: 'App', siteId: 'site-1' },
    newJiraIssueTargetProjectSelectionKey: 'site-1:100',
    newJiraIssueTargetType: { id: 'bug', name: 'Bug' },
    newJiraIssueAssignee: null,
    setNewJiraIssueAssignee: vi.fn(),
    discardNewJiraIssueDraft: vi.fn(),
    setJiraRefreshNonce: vi.fn(),
    setJiraIssues: vi.fn(),
    setSelectedJiraIssue: vi.fn(),
    submitShortcutLabel: 'Ctrl+Enter'
  } satisfies Partial<TaskPageComposerActionsModel>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Supplies all fields read by the shipping dialog and creation hook; unrelated task-page controls are inactive.
  const dialogModel = model as unknown as TaskPageComposerActionsModel
  useTaskPageJiraIssueCreation(dialogModel)
  return <TaskPageJiraIssueDialog model={dialogModel} />
}

async function submitIdentity(key: string, id: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))
  await waitFor(() =>
    expect(create).toHaveBeenCalledExactlyOnceWith(source, {
      siteId: 'site-1',
      projectId: '100',
      issueTypeId: 'bug',
      title: 'Fix reporter selection',
      description: undefined,
      customFields: { [key]: id },
      userFieldKeys: [key]
    })
  )
}

it('shipping schema dispatch selects a directory user and submits identity, not display text', async () => {
  search.mockResolvedValue([{ accountId: 'account-123', displayName: 'Ada Lovelace' }])
  render(<CreateDialog />)
  fireEvent.click(screen.getByRole('button', { name: 'Reporter' }))
  fireEvent.change(screen.getByPlaceholderText('Search users'), {
    target: { value: 'Ada Lovelace' }
  })
  expect(screen.getByRole('button', { name: 'Create issue' }).hasAttribute('disabled')).toBe(true)
  expect(create).not.toHaveBeenCalled()
  const directoryUser = await screen.findByRole('button', { name: 'Ada Lovelace' })
  expect(
    screen.getAllByRole('button', { name: /Ada Lovelace/ }).map((row) => row.textContent)
  ).toEqual(['Ada Lovelace', 'Use known user ID "Ada Lovelace"'])
  fireEvent.click(directoryUser)
  expect(search).toHaveBeenCalledWith(source, 'Ada Lovelace', 'site-1')
  expect(screen.getByRole('button', { name: 'Reporter' }).textContent).toBe('Ada Lovelace')
  await submitIdentity('reporter', 'account-123')
})

it.each(['empty', 'denied', 'pending'])(
  'explicit known identity remains usable with %s search',
  async (result) => {
    if (result === 'empty') {
      search.mockResolvedValue([])
    } else if (result === 'denied') {
      search.mockRejectedValue(new Error('Browse users denied'))
    } else {
      search.mockReturnValue(new Promise(() => {}))
    }
    render(<CreateDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Reporter' }))
    fireEvent.change(screen.getByPlaceholderText('Search users'), {
      target: { value: '  account-known  ' }
    })
    await waitFor(() => expect(search).toHaveBeenCalledWith(source, '  account-known  ', 'site-1'))
    if (result !== 'pending') {
      await screen.findByText('No users found')
    }
    expect(screen.getByRole('button', { name: 'Create issue' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Use known user ID "account-known"' }))
    await submitIdentity('reporter', 'account-known')
  }
)

it('preserves supplied scalar metadata choices (constructed contract fixture, not observed Jira data)', async () => {
  const field: JiraCreateField = {
    key: 'customfield_9',
    name: 'Reviewer',
    required: true,
    schema: { type: 'user' },
    allowedValues: [{ name: 'ada.login' }]
  }
  render(<CreateDialog field={field} />)
  const user = userEvent.setup()
  const trigger = screen.getByText('Select Reviewer').closest('button[role="combobox"]')
  if (!trigger) {
    throw new Error('Metadata Select trigger missing')
  }
  await user.click(trigger)
  await user.click(screen.getByRole('option', { name: 'ada.login' }))
  expect(search).not.toHaveBeenCalled()
  await submitIdentity('customfield_9', 'ada.login')
})
