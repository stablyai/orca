// @vitest-environment happy-dom

import React, { act } from 'react'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../../shared/jira-types'
import SmartWorkspaceNameField, {
  type SmartWorkspaceNameSelection
} from './SmartWorkspaceNameField'

const jiraMock = vi.hoisted(() => ({
  retry: vi.fn(),
  selectAccount: vi.fn(),
  state: {
    intent: true,
    loading: true,
    issue: null,
    boundSourceContext: null,
    accountChoices: [],
    errorKind: null
  } as {
    intent: boolean
    loading: boolean
    issue: null
    boundSourceContext: null
    accountChoices: {
      id: string
      siteUrl: string
      email: string
      displayName: string
      accountId: string
    }[]
    errorKind: 'disconnected' | 'site-not-connected' | 'read-failed' | 'update-runtime' | null
  }
}))
const shellMock = vi.hoisted(() => ({ openUrl: vi.fn() }))
const popoverMock = vi.hoisted(() => ({ contentMounted: true }))
const jiraSearchMock = vi.hoisted(() => vi.fn(async (): Promise<JiraIssue[]> => []))
const jiraConnectionMock = vi.hoisted(() => ({
  status: {
    connected: false,
    viewer: null,
    sites: []
  }
}))
const originalWindowApi = window.api

vi.mock('./use-jira-url-source', () => ({
  useJiraUrlSource: () => ({
    ...jiraMock.state,
    retry: jiraMock.retry,
    selectAccount: jiraMock.selectAccount
  })
}))

vi.mock('./use-jira-source-connection', () => ({
  useJiraSourceConnection: ({ sourceContext }: { sourceContext: unknown }) =>
    sourceContext
      ? { status: jiraConnectionMock.status, loaded: true }
      : { status: null, loaded: false }
}))

vi.mock('@/store', () => {
  const state = {
    repos: [],
    addRepo: vi.fn(),
    checkLinearConnection: vi.fn(),
    fetchWorkItems: vi.fn(),
    fetchWorkItemsAcrossRepos: vi.fn(),
    getCachedWorkItems: vi.fn(() => null),
    linearStatus: { connected: false },
    linearStatusChecked: false,
    listLinearIssues: vi.fn(),
    preflightStatus: null,
    preflightStatusChecked: false,
    preflightStatusContextKey: null,
    refreshPreflightStatus: vi.fn(),
    searchJiraIssues: jiraSearchMock,
    searchLinearIssues: vi.fn(),
    settings: null
  }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => ({}),
  localPreflightContextKey: () => 'test-preflight-context'
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) =>
    popoverMock.contentMounted ? <div>{children}</div> : null
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({
    children,
    onValueChange
  }: {
    children: React.ReactNode
    onValueChange?: (value: string) => void
  }) => (
    <div
      onClick={(event) => {
        const value = (event.target as HTMLElement)
          .closest<HTMLElement>('[data-tab-value]')
          ?.getAttribute('data-tab-value')
        if (value) {
          onValueChange?.(value)
        }
      }}
    >
      {children}
    </div>
  ),
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button type="button" data-tab-value={value}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

function renderField(
  overrides: {
    jiraSourceContext?: boolean
    onPlainEnter?: () => void
    onOpenJiraSettings?: () => void
    onValueChange?: (value: string) => void
    onClearSelectedSource?: () => void
    value?: string
    selectedSource?: SmartWorkspaceNameSelection | null
  } = {}
) {
  return render(
    <SmartWorkspaceNameField
      repos={[]}
      repoId="repo-1"
      onRepoChange={vi.fn()}
      value={overrides.value ?? 'https://company.atlassian.net/browse/ORCA-123'}
      onValueChange={overrides.onValueChange ?? vi.fn()}
      onGitHubItemSelect={vi.fn()}
      onBranchSelect={vi.fn()}
      onLinearIssueSelect={vi.fn()}
      selectedSource={overrides.selectedSource ?? null}
      onClearSelectedSource={overrides.onClearSelectedSource ?? vi.fn()}
      jiraSourceContext={
        overrides.jiraSourceContext
          ? ({
              kind: 'task-source-context',
              provider: 'jira',
              projectId: 'project-1',
              hostId: 'local',
              projectHostSetupId: null,
              repoId: 'repo-1',
              providerIdentity: null,
              accountLabel: null
            } as never)
          : null
      }
      onPlainEnter={overrides.onPlainEnter}
      onOpenJiraSettings={overrides.onOpenJiraSettings}
    />
  )
}

describe('SmartWorkspaceNameField Jira accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { shell: shellMock }
    })
    jiraSearchMock.mockResolvedValue([])
    Object.assign(jiraMock.state, {
      intent: true,
      loading: true,
      issue: null,
      boundSourceContext: null,
      accountChoices: [],
      errorKind: null
    })
    popoverMock.contentMounted = true
    Object.assign(jiraConnectionMock.status, {
      connected: false,
      viewer: null,
      sites: []
    })
  })

  afterEach(() => {
    cleanup()
    if (originalWindowApi === undefined) {
      Reflect.deleteProperty(window, 'api')
    } else {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalWindowApi
      })
    }
  })

  it('associates loading status with the busy input and blocks plain Enter', () => {
    const onPlainEnter = vi.fn()
    renderField({ onPlainEnter })
    const input = screen.getByRole('textbox')
    const status = screen.getByRole('status')

    expect(input.getAttribute('aria-busy')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(status.id)
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toContain('Loading Jira issue')

    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(onPlainEnter).not.toHaveBeenCalled()
  })

  it('keeps selected-source actions out of Tab order with keyboard fallbacks', () => {
    const onClearSelectedSource = vi.fn()
    const onPlainEnter = vi.fn()
    renderField({
      onClearSelectedSource,
      onPlainEnter,
      selectedSource: {
        kind: 'github-issue',
        label: 'Issue #123',
        url: 'https://github.com/orca/ide/issues/123'
      }
    })

    expect(screen.getByRole('button', { name: 'Open link in browser' }).tabIndex).toBe(-1)
    expect(screen.getByRole('button', { name: 'Clear selected source' }).tabIndex).toBe(-1)

    const pill = document.querySelector<HTMLElement>('[data-workspace-source-pill="true"]')
    expect(pill?.getAttribute('aria-keyshortcuts')).toBe('Alt+Enter Backspace Delete')

    fireEvent.keyDown(pill as HTMLElement, { key: 'Backspace' })
    expect(onClearSelectedSource).toHaveBeenCalledOnce()

    fireEvent.keyDown(pill as HTMLElement, { key: 'Enter', altKey: true })
    expect(shellMock.openUrl).toHaveBeenCalledWith('https://github.com/orca/ide/issues/123')
    expect(onPlainEnter).not.toHaveBeenCalled()
  })

  it('shows Jira as a source mode only when the selected workspace host is connected', () => {
    Object.assign(jiraMock.state, { intent: false, loading: false })
    const { rerender } = renderField({ jiraSourceContext: true })

    expect(screen.queryByText('Jira')).toBeNull()
    Object.assign(jiraConnectionMock.status, { connected: true })

    rerender(
      <SmartWorkspaceNameField
        repos={[]}
        repoId="repo-1"
        onRepoChange={vi.fn()}
        value=""
        onValueChange={vi.fn()}
        onGitHubItemSelect={vi.fn()}
        onBranchSelect={vi.fn()}
        onLinearIssueSelect={vi.fn()}
        selectedSource={null}
        onClearSelectedSource={vi.fn()}
        jiraSourceContext={
          {
            kind: 'task-source-context',
            provider: 'jira',
            projectId: 'project-1',
            hostId: 'local',
            projectHostSetupId: null,
            repoId: 'repo-1',
            providerIdentity: null,
            accountLabel: null
          } as never
        }
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Jira' }))

    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe(
      'Search Jira issues or paste an issue URL'
    )
  })

  it('offers a Settings recovery action for a disconnected Jira source', () => {
    Object.assign(jiraMock.state, { loading: false, errorKind: 'disconnected' })
    const onOpenJiraSettings = vi.fn()
    renderField({ onOpenJiraSettings })

    expect(screen.getByRole('status').textContent).toContain(
      'Connect Jira in Settings to link this issue'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onOpenJiraSettings).toHaveBeenCalled()
  })

  it('keeps blocking status and recovery mounted when the results popover closes', () => {
    Object.assign(jiraMock.state, { loading: false, errorKind: 'disconnected' })
    popoverMock.contentMounted = false
    const onOpenJiraSettings = vi.fn()
    renderField({ onOpenJiraSettings })

    expect(screen.getByRole('status').textContent).toContain(
      'Connect Jira in Settings to link this issue'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onOpenJiraSettings).toHaveBeenCalled()
  })

  it('replaces the combined field value only for recognized Jira URL pastes', () => {
    const onValueChange = vi.fn()
    renderField({ value: 'existing-name', onValueChange })
    const jiraUrl = 'https://company.atlassian.net/browse/ORCA-456'
    const input = screen.getByRole('textbox')
    const event = createEvent.paste(input, {
      clipboardData: { getData: () => jiraUrl }
    })

    fireEvent(input, event)

    expect(event.defaultPrevented).toBe(true)
    expect(onValueChange).toHaveBeenCalledWith(jiraUrl)
  })

  it('leaves ordinary paste to the input selection and native change event', () => {
    const onValueChange = vi.fn()
    renderField({ value: 'my--bug', onValueChange })
    const input = screen.getByRole('textbox')
    const event = createEvent.paste(input, {
      clipboardData: { getData: () => 'jira' }
    })

    fireEvent(input, event)

    expect(event.defaultPrevented).toBe(false)
    expect(onValueChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'my-jira-bug' } })
    expect(onValueChange).toHaveBeenCalledWith('my-jira-bug')
  })

  it('labels all-site Jira results with the bound site and account', async () => {
    Object.assign(jiraMock.state, { intent: false, loading: false })
    Object.assign(jiraConnectionMock.status, {
      connected: true,
      selectedSiteId: 'all',
      sites: [
        {
          id: 'site-a',
          siteUrl: 'https://company.atlassian.net',
          email: 'ada@example.com',
          displayName: 'Company Jira',
          accountId: 'account-a'
        }
      ]
    })
    jiraSearchMock.mockResolvedValueOnce([
      {
        id: 'jira-1',
        key: 'ORCA-123',
        siteId: 'site-a',
        siteName: 'Company Jira',
        title: 'Disambiguate Jira search',
        url: 'https://company.atlassian.net/browse/ORCA-123',
        project: { id: 'project-1', key: 'ORCA', name: 'Orca' },
        issueType: { id: 'type-1', name: 'Task' },
        status: { id: 'status-1', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
        labels: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ])
    renderField({ jiraSourceContext: true, value: 'ORCA-123' })

    fireEvent.click(screen.getByRole('button', { name: 'Jira' }))

    expect(
      await screen.findByRole('button', {
        name: /ORCA-123.*Disambiguate Jira search.*Company Jira.*ada@example.com/
      })
    ).not.toBeNull()
  })

  it('labels duplicate-account choices with site and account', () => {
    Object.assign(jiraMock.state, {
      loading: false,
      accountChoices: [
        {
          id: 'site-a',
          siteUrl: 'https://company.atlassian.net',
          email: 'ada@example.com',
          displayName: 'Company Jira',
          accountId: 'account-a'
        }
      ]
    })
    renderField()

    const account = screen.getByRole('button', { name: /Company Jira.*ada@example.com/ })
    fireEvent.click(account)
    expect(jiraMock.selectAccount).toHaveBeenCalledWith('site-a')
  })
})
