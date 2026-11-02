// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { taskSourceRuntimeTarget } from '@/lib/task-source-runtime-target'
import type { JiraConnectionStatus, JiraIssue, JiraUser } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { AppState } from '@/store/types'
import { JiraIssueMetadataBar } from './jira-issue-workspace-chrome'

const boundary = vi.hoisted(() => ({
  readJiraStatus: vi.fn(),
  search: vi.fn(),
  statusKey: 'local#0'
}))
const self: JiraUser = { accountId: 'me', displayName: 'Zoe me' }
const users: JiraUser[] = [
  { accountId: 'zoe', displayName: 'Zoe' },
  { accountId: 'ada', displayName: 'Ada' },
  self
]
const status: JiraConnectionStatus = {
  connected: true,
  activeSiteId: 'site-1',
  viewer: { ...self, email: null }
}
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListAssignableUsersForTarget: boundary.search,
  jiraSearchUsers: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) =>
    selector({
      settings: null,
      jiraStatus: status,
      jiraStatusContextKey: boundary.statusKey,
      jiraConnectionRevisions: {},
      readJiraStatus: boundary.readJiraStatus
    })
}))
const issue: JiraIssue = {
  id: '100',
  key: 'ENG-1',
  siteId: 'site-1',
  title: 'Issue',
  url: 'https://jira.invalid/ENG-1',
  project: { id: '1', key: 'ENG', name: 'Engineering' },
  issueType: { id: '1', name: 'Task' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'New' },
  labels: [],
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01'
}
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: '1',
  hostId: 'runtime:remote'
}
function mount(
  options: {
    selected?: JiraIssue
    sourceContext?: TaskSourceContext
    pendingField?: string
    owner?: RuntimeClientTarget
    runtimeContextKey?: string
  } = {}
) {
  const mutateIssue = vi.fn(async () => ({ ok: true as const }))
  const props = {
    displayed: options.selected ?? issue,
    transitions: [],
    transitionsLoading: false,
    transitionsError: null,
    reloadTransitions: vi.fn(),
    priorities: [],
    pendingField: options.pendingField ?? null,
    mutateIssue,
    owner:
      options.owner ??
      (options.sourceContext
        ? taskSourceRuntimeTarget(options.sourceContext)
        : { kind: 'local' as const }),
    runtimeContextKey: options.runtimeContextKey ?? 'local#0',
    sourceContext: options.sourceContext
  }
  return { mutateIssue, props, ...render(<JiraIssueMetadataBar {...props} />) }
}
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  boundary.statusKey = 'local#0'
  boundary.search.mockResolvedValue(users)
})
describe('Existing Jira issue assignee', () => {
  it('assigns the signed-in site account directly without opening the picker', async () => {
    const { mutateIssue } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Assign to me (Zoe me)' }))
    expect(mutateIssue).toHaveBeenCalledWith(
      'assignee',
      { assigneeAccountId: 'me' },
      { assignee: expect.objectContaining(self) }
    )
    expect(screen.queryByPlaceholderText('Search users')).toBeNull()
  })
  it('offers self first, alphabetic candidates, issue-scoped search, and unassignment', async () => {
    const { mutateIssue } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    const search = await screen.findByPlaceholderText('Search users')
    await screen.findByRole('button', { name: 'Ada' })
    const rows = screen.getAllByRole('button').map((button) => button.textContent)
    expect(rows.indexOf('Zoe me')).toBeLessThan(rows.indexOf('Ada'))
    expect(rows.indexOf('Ada')).toBeLessThan(rows.indexOf('Zoe'))
    boundary.search.mockResolvedValue([{ accountId: 'beth', displayName: 'Beth' }])
    fireEvent.change(search, { target: { value: 'Beth' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Beth' }))
    expect(boundary.search).toHaveBeenLastCalledWith({ kind: 'local' }, 'ENG-1', 'Beth', 'site-1')
    expect(mutateIssue).toHaveBeenCalledWith(
      'assignee',
      { assigneeAccountId: 'beth' },
      { assignee: { accountId: 'beth', displayName: 'Beth' } }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unassigned' }))
    expect(mutateIssue).toHaveBeenLastCalledWith(
      'assignee',
      { assigneeAccountId: null },
      { assignee: undefined }
    )
  })
  it('loads the viewer from the selected source and hides it during an account switch', async () => {
    let resolve = (_status: JiraConnectionStatus) => {}
    boundary.readJiraStatus.mockReturnValue(
      new Promise<JiraConnectionStatus>((done) => {
        resolve = done
      })
    )
    const { rerender, props, mutateIssue } = mount({ sourceContext: source })
    expect(screen.queryByRole('button', { name: 'Assign to me (Zoe me)' })).toBeNull()
    const remoteUser = { accountId: 'remote-me', displayName: 'Remote me' }
    await act(async () => resolve({ ...status, viewer: { ...remoteUser, email: null } }))
    fireEvent.click(await screen.findByRole('button', { name: 'Assign to me (Remote me)' }))
    expect(boundary.readJiraStatus).toHaveBeenCalledWith(source)
    expect(mutateIssue).toHaveBeenLastCalledWith(
      'assignee',
      { assigneeAccountId: 'remote-me' },
      { assignee: { ...remoteUser, email: null, avatarUrl: undefined } }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    await screen.findByRole('button', { name: 'Ada' })
    expect(boundary.search).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'remote' },
      'ENG-1',
      '',
      'site-1'
    )
    boundary.readJiraStatus.mockReturnValue(new Promise(() => {}))
    rerender(
      <JiraIssueMetadataBar {...props} sourceContext={{ ...source, accountLabel: 'other' }} />
    )
    expect(screen.queryByRole('button', { name: 'Assign to me (Remote me)' })).toBeNull()
  })
  it('drops candidate rows on site changes and ignores a late search from the old site', async () => {
    let resolve = (_users: JiraUser[]) => {}
    boundary.search.mockReturnValue(
      new Promise<JiraUser[]>((done) => {
        resolve = done
      })
    )
    const { rerender, props } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    fireEvent.change(await screen.findByPlaceholderText('Search users'), {
      target: { value: 'Old' }
    })
    await waitFor(() => expect(boundary.search).toHaveBeenCalledTimes(1))
    rerender(<JiraIssueMetadataBar {...props} displayed={{ ...issue, siteId: 'site-2' }} />)
    await act(async () => resolve([{ accountId: 'old', displayName: 'Old user' }]))
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    expect(screen.queryByRole('button', { name: 'Old user' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Assign to me (Zoe me)' })).toBeNull()
  })
  it('routes an account owner independently of settings and drops the old owner search', async () => {
    let finishOldSearch = (_users: JiraUser[]): void => {}
    boundary.statusKey = 'runtime:account-a#0'
    boundary.search.mockReturnValue(
      new Promise<JiraUser[]>((resolve) => {
        finishOldSearch = resolve
      })
    )
    const { rerender, props } = mount({
      owner: { kind: 'environment', environmentId: 'account-a' },
      runtimeContextKey: 'runtime:account-a#0'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    await waitFor(() =>
      expect(boundary.search).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'account-a' },
        'ENG-1',
        '',
        'site-1'
      )
    )
    boundary.search.mockResolvedValue([{ accountId: 'new', displayName: 'New owner user' }])
    rerender(
      <JiraIssueMetadataBar
        {...props}
        owner={{ kind: 'environment', environmentId: 'account-b' }}
        runtimeContextKey="runtime:account-b#0"
      />
    )
    await act(async () => finishOldSearch([{ accountId: 'old', displayName: 'Old owner user' }]))
    expect(screen.queryByRole('button', { name: 'Assign to me (Zoe me)' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    await screen.findByRole('button', { name: 'New owner user' })
    expect(screen.queryByRole('button', { name: 'Old owner user' })).toBeNull()
    expect(boundary.search).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'account-b' },
      'ENG-1',
      '',
      'site-1'
    )
  })
  it('disables both assignment actions while another field saves', () => {
    mount({ pendingField: 'title' })
    expect(screen.getByRole('button', { name: 'Assignee' }).hasAttribute('disabled')).toBe(true)
    expect(
      screen.getByRole('button', { name: 'Assign to me (Zoe me)' }).hasAttribute('disabled')
    ).toBe(true)
  })
  it('does not offer self assignment when the issue is already assigned to self', () => {
    mount({ selected: { ...issue, assignee: self } })
    expect(screen.queryByRole('button', { name: 'Assign to me (Zoe me)' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Assignee' }).textContent).toBe('Zoe me')
  })
  it('hides a viewer cached for a different runtime', () => {
    boundary.statusKey = 'runtime:other#0'
    mount()
    expect(screen.queryByRole('button', { name: 'Assign to me (Zoe me)' })).toBeNull()
  })
  it('ignores assignment from a previously opened picker while another field saves', async () => {
    const { props, rerender, mutateIssue } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    await screen.findByRole('button', { name: 'Ada' })
    rerender(<JiraIssueMetadataBar {...props} pendingField="title" />)
    fireEvent.click(screen.getByRole('button', { name: 'Ada' }))
    expect(mutateIssue).not.toHaveBeenCalled()
  })
})
