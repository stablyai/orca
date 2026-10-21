// @vitest-environment happy-dom
import React, { createRef, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { JiraConnectionStatus, JiraIssue, JiraSite } from '../../../../shared/jira-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearConnectionStatus } from '../../../../shared/linear/workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import type { JiraUrlSourceState } from '../new-workspace/use-jira-url-source'
import type * as JiraUrlSourceModule from '../new-workspace/use-jira-url-source'
import type * as JiraSourceConnectionModule from '../new-workspace/use-jira-source-connection'
import { bindJiraIssueSourceContext } from '../new-workspace/use-jira-url-source'
import { getWorkspaceAttachmentSourceContext } from './workspace-attachment-source-result'
import { WorkspaceAttachmentComposer } from './WorkspaceAttachmentComposer'

const sourceMock = vi.hoisted(() => {
  const jiraState: Omit<JiraUrlSourceState, 'retry' | 'selectAccount'> = {
    intent: false,
    loading: false,
    issue: null,
    boundSourceContext: null,
    accountChoices: [],
    errorKind: null
  }
  const jiraStatus: JiraConnectionStatus = { connected: false, viewer: null, sites: [] }
  const linearStatus: LinearConnectionStatus = { connected: false, viewer: null }
  return {
    jiraState,
    jiraStatus,
    linearStatus,
    retryJira: vi.fn(),
    selectAccount: vi.fn(),
    readLinearStatus: vi.fn<() => Promise<LinearConnectionStatus>>()
  }
})
vi.mock('../new-workspace/use-jira-url-source', async (importOriginal) => ({
  ...(await importOriginal<typeof JiraUrlSourceModule>()),
  useJiraUrlSource: () => ({
    ...sourceMock.jiraState,
    retry: sourceMock.retryJira,
    selectAccount: sourceMock.selectAccount
  })
}))
vi.mock('../new-workspace/use-jira-source-connection', async (importOriginal) => ({
  ...(await importOriginal<typeof JiraSourceConnectionModule>()),
  useJiraSourceConnection: () => ({ status: sourceMock.jiraStatus, loaded: true })
}))
vi.mock('@/runtime/runtime-linear-client', () => ({ linearStatus: sourceMock.readLinearStatus }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>
}))

const initialState = useAppStore.getInitialState()
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'ssh:dev',
  gitRemoteIdentity: {
    canonicalKey: 'github.com/acme/orca',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/acme/orca.git'
  }
}
const jiraUrl = 'https://company.atlassian.net/browse/ORCA-123'
const linearUrl = 'https://linear.app/acme/issue/ORCA-123/fix-it'
const site: JiraSite = {
  id: 'site-2',
  siteUrl: 'https://company.atlassian.net',
  email: 'chosen@example.com',
  displayName: 'Chosen account',
  accountId: 'account-2'
}
const jiraIssue: JiraIssue = {
  id: 'issue-123',
  key: 'ORCA-123',
  title: 'Fix it',
  url: jiraUrl,
  siteId: site.id,
  project: { id: 'project-jira', key: 'ORCA', name: 'Orca' },
  issueType: { id: 'bug', name: 'Bug' },
  status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To do' },
  labels: [],
  createdAt: '',
  updatedAt: ''
}
const linearIssue: LinearIssue = {
  id: 'linear-123',
  identifier: 'ORCA-123',
  title: 'Fix it',
  url: linearUrl,
  workspaceId: 'acme-workspace',
  workspaceName: 'Acme',
  state: { name: 'Todo', type: 'unstarted', color: '' },
  team: { id: 'team', name: 'Orca', key: 'ORCA' },
  labels: [],
  labelIds: [],
  priority: 0,
  updatedAt: ''
}
const connectedLinear: LinearConnectionStatus = {
  connected: true,
  viewer: null,
  activeWorkspaceId: 'acme-workspace',
  workspaces: [
    {
      id: 'acme-workspace',
      organizationId: 'acme',
      organizationName: 'Acme',
      organizationUrlKey: 'acme',
      displayName: 'Account',
      email: null
    }
  ]
}
const onAdd = vi.fn<(item: WorkspaceAttachment) => boolean>(() => true)
const fetchLinearIssue = vi.fn<() => Promise<LinearIssue | null>>()

function composer(value: string): React.JSX.Element {
  return (
    <WorkspaceAttachmentComposer
      items={[]}
      repo={repo}
      disabled={false}
      initialKind="github-issue"
      initialInput={value}
      inputRef={createRef()}
      onAdd={onAdd}
      onSave={vi.fn()}
      getScopeError={() => null}
      error={null}
      onQueryChange={vi.fn()}
    />
  )
}
function input(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Search references' })
}
function direct(): HTMLElement {
  return screen.getByRole('option', { name: /^Add ORCA-123/ })
}
function enter(): void {
  fireEvent.keyDown(input(), { key: 'Enter' })
}

describe('workspace reference URL resolution and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState(initialState, true)
    useAppStore.setState({
      fetchWorkItems: vi.fn(async () => []),
      getCachedWorkItems: vi.fn(() => []),
      refreshPreflightStatus: vi.fn(async () => {}),
      checkLinearConnection: vi.fn(async () => {}),
      linearStatusChecked: true,
      fetchLinearIssue,
      searchLinearIssues: vi.fn(async () => []),
      listLinearIssues: vi.fn(async () => ({ items: [] }))
    })
    Object.assign(sourceMock.jiraState, {
      intent: false,
      loading: false,
      issue: null,
      boundSourceContext: null,
      accountChoices: [],
      errorKind: null
    })
    sourceMock.jiraStatus = { connected: false, viewer: null, sites: [] }
    sourceMock.linearStatus = { connected: false, viewer: null }
    sourceMock.readLinearStatus.mockImplementation(async () => sourceMock.linearStatus)
    fetchLinearIssue.mockResolvedValue(null)
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(cleanup)

  it('blocks pasted Jira URLs while loading, including plain Enter', () => {
    Object.assign(sourceMock.jiraState, { intent: true, loading: true })
    render(composer(jiraUrl))
    expect(direct().getAttribute('data-disabled')).toBe('true')
    expect(screen.getByRole('status').textContent).toContain('Loading Jira issue')
    enter()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it.each([
    ['disconnected', 'Connect Jira in Settings'],
    ['site-not-connected', 'This Jira site is not connected'],
    ['read-failed', 'Couldn’t load this Jira issue'],
    ['update-runtime', 'Update the remote runtime']
  ] as const)(
    'shows %s guidance and retries without discarding the query',
    (errorKind, message) => {
      Object.assign(sourceMock.jiraState, { intent: true, errorKind })
      render(composer(jiraUrl))
      expect(screen.getByRole('status').textContent).toContain(message)
      expect(direct().getAttribute('data-disabled')).toBe('true')
      enter()
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(sourceMock.retryJira).toHaveBeenCalledOnce()
      expect(input()).toHaveProperty('value', jiraUrl)
      expect(onAdd).not.toHaveBeenCalled()
    }
  )

  it('requires an account choice and attaches the resolved Jira account on the execution host', async () => {
    const otherSite = { ...site, id: 'site-1', email: 'other@example.com' }
    sourceMock.jiraStatus = { connected: true, viewer: null, sites: [otherSite, site] }
    Object.assign(sourceMock.jiraState, { intent: true, accountChoices: [otherSite, site] })
    const view = render(composer(jiraUrl))
    expect(direct().getAttribute('data-disabled')).toBe('true')
    expect(screen.getByRole('status').textContent).toContain('Choose a Jira account')
    fireEvent.click(screen.getByRole('option', { name: /chosen@example.com/ }))
    expect(sourceMock.selectAccount).toHaveBeenCalledWith(site.id)
    const context = getWorkspaceAttachmentSourceContext('jira', repo, undefined)
    if (!context) {
      throw new Error('Expected Jira source context')
    }
    Object.assign(sourceMock.jiraState, {
      accountChoices: [],
      issue: jiraIssue,
      boundSourceContext: bindJiraIssueSourceContext(context, site, jiraIssue)
    })
    view.rerender(composer(jiraUrl))
    await waitFor(() => expect(direct().getAttribute('data-disabled')).not.toBe('true'))
    enter()
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'jira',
        title: 'Fix it',
        taskSourceContext: expect.objectContaining({
          hostId: 'ssh:dev',
          accountLabel: site.email,
          providerIdentity: expect.objectContaining({ siteId: site.id })
        })
      })
    )
  })

  it('waits for remote Linear connection and issue lookup before attaching the bound workspace', async () => {
    let finishStatus: ((status: LinearConnectionStatus) => void) | undefined
    let finishIssue: ((issue: LinearIssue) => void) | undefined
    sourceMock.readLinearStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStatus = resolve
        })
    )
    fetchLinearIssue.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishIssue = resolve
        })
    )
    render(composer(linearUrl))
    expect(screen.getByRole('status').textContent).toContain('Loading Linear issue')
    enter()
    expect(onAdd).not.toHaveBeenCalled()
    await act(async () => finishStatus?.(connectedLinear))
    await waitFor(() => expect(fetchLinearIssue).toHaveBeenCalled())
    expect(direct().getAttribute('data-disabled')).toBe('true')
    enter()
    expect(onAdd).not.toHaveBeenCalled()
    await act(async () => finishIssue?.(linearIssue))
    await waitFor(() => expect(direct().getAttribute('data-disabled')).not.toBe('true'))
    enter()
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'linear',
        linearWorkspaceId: 'acme-workspace',
        title: 'Fix it',
        taskSourceContext: expect.objectContaining({
          hostId: 'ssh:dev',
          providerIdentity: expect.objectContaining({ workspaceId: 'acme-workspace' })
        })
      })
    )
  })

  it('recovers from disconnected Linear without replacing the draft or pasted query', async () => {
    render(composer(linearUrl))
    await screen.findByText('Connect Linear in Settings to link this issue.')
    enter()
    expect(onAdd).not.toHaveBeenCalled()
    sourceMock.linearStatus = connectedLinear
    fetchLinearIssue.mockResolvedValue(linearIssue)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(input()).toHaveProperty('value', linearUrl)
    await waitFor(() => expect(direct().getAttribute('data-disabled')).not.toBe('true'))
    enter()
    expect(onAdd).toHaveBeenCalledOnce()
  })

  it('keeps failed Linear URL lookup blocked and retries the same URL', async () => {
    sourceMock.linearStatus = connectedLinear
    render(composer(linearUrl))
    await screen.findByText(
      'Couldn’t load this Linear issue. Check the URL and connected workspace.'
    )
    expect(direct().getAttribute('data-disabled')).toBe('true')
    enter()
    expect(onAdd).not.toHaveBeenCalled()
    fetchLinearIssue.mockResolvedValue(linearIssue)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(direct().getAttribute('data-disabled')).not.toBe('true'))
    enter()
    expect(onAdd).toHaveBeenCalledOnce()
  })

  it('retains explicit bare task identifiers as manual attachments', () => {
    render(
      <WorkspaceAttachmentComposer
        items={[]}
        repo={repo}
        disabled={false}
        initialKind="linear-issue"
        initialInput="ORCA-123"
        inputRef={createRef()}
        onAdd={onAdd}
        onSave={vi.fn()}
        getScopeError={() => null}
        error={null}
        onQueryChange={vi.fn()}
      />
    )
    expect(direct().getAttribute('data-disabled')).not.toBe('true')
    enter()
    expect(onAdd).toHaveBeenCalledOnce()
  })
})
