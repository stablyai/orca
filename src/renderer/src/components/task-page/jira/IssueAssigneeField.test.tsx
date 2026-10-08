// @vitest-environment happy-dom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskPageJiraIssueAssigneeField } from './IssueAssigneeField'

const search = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-jira-client', () => ({ jiraListAssignableUsersForProject: search }))
afterEach(cleanup)

it('drops old provider candidates before another host with identical project IDs can select them', async () => {
  const onSelect = vi.fn()
  const model: ComponentProps<typeof TaskPageJiraIssueAssigneeField>['model'] = {
    settings: null,
    jiraTaskSourceContext: null,
    jiraStatusCurrent: true,
    jiraStatus: {
      connected: true,
      activeSiteId: 'same-site',
      viewer: { accountId: 'local-me', displayName: 'Local me', email: null }
    },
    jiraCreateFields: [{ key: 'assignee', name: 'Assignee', required: false }],
    newJiraIssueTargetProject: { id: '100', key: 'PRJ', name: 'Project', siteId: 'same-site' },
    newJiraIssueAssignee: null,
    setNewJiraIssueAssignee: onSelect,
    newJiraIssueSubmitting: false,
    providerRuntimeContextKey: 'local'
  }
  search.mockResolvedValueOnce([{ accountId: 'local-user', displayName: 'Local user' }])
  const { rerender } = render(<TaskPageJiraIssueAssigneeField model={model} />)
  fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
  await screen.findByRole('button', { name: 'Local user' })
  expect(screen.getByRole('button', { name: 'Assign to me (Local me)' })).toBeTruthy()
  expect(search).toHaveBeenCalledWith(null, 'PRJ', '', 'same-site')

  search.mockReturnValueOnce(new Promise(() => {}))
  rerender(
    <TaskPageJiraIssueAssigneeField
      model={{ ...model, providerRuntimeContextKey: 'runtime:remote', jiraStatusCurrent: false }}
    />
  )
  expect(screen.queryByRole('button', { name: 'Local user' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
  await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('button', { name: 'Local user' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Assign to me (Local me)' })).toBeNull()
  rerender(
    <TaskPageJiraIssueAssigneeField
      model={{
        ...model,
        providerRuntimeContextKey: 'runtime:remote',
        jiraStatus: {
          ...model.jiraStatus,
          viewer: { accountId: 'remote-me', displayName: 'Remote me', email: null }
        }
      }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Assign to me (Remote me)' }))
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'remote-me' }))
})
