import { linearIssueReadFixture } from '@/store/slices/linear-slice-test-harness'
// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

import type { LinearIssue } from '../../../../shared/linear/issue-types'

import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { NormalizedWorkItemSourceSearchProps } from './smart-workspace-name-field-model'
import { useWorkItemSourceSearch } from './use-work-item-source-search'
import { referenceLinearIssue } from '../sidebar/workspace-card/review/workspace-reference-fixtures.test-support'

const mocks = vi.hoisted(() => ({
  readStatus: vi.fn(),
  listGitlabWorkItems: vi.fn(),
  readJiraSource: vi.fn(() => ({ intent: false })),
  state: {
    addRepo: vi.fn(),
    checkLinearConnection: vi.fn(),
    linearStatus: { connected: false, viewer: null, selectedWorkspaceId: 'focused-workspace' },
    linearStatusChecked: true,
    linearStatusContextKey: 'local#0',
    settings: null,
    preflightStatus: null,
    preflightStatusChecked: true,
    preflightStatusContextKey: 'test',
    refreshPreflightStatus: vi.fn(),
    listLinearIssues: vi.fn(async () => ({ items: [] })),
    searchLinearIssues: vi.fn<
      (query: string, limit: number, options: { workspaceId?: string }) => Promise<LinearIssue[]>
    >(async () => [])
  }
}))
vi.mock('@/runtime/runtime-linear-client', () => ({ linearStatus: mocks.readStatus }))
vi.mock('@/lib/gitlab-work-item-source-lookup', () => ({
  listGitLabWorkItemsForSource: mocks.listGitlabWorkItems,
  lookupGitLabWorkItemByPathForSource: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        ...mocks.state,
        listLinearIssues: (...args: Parameters<typeof mocks.state.listLinearIssues>) =>
          linearIssueReadFixture(() => mocks.state.listLinearIssues(...args)),
        searchLinearIssues: (...args: Parameters<typeof mocks.state.searchLinearIssues>) =>
          linearIssueReadFixture(() => mocks.state.searchLinearIssues(...args))
      }),
    { getState: () => mocks.state, subscribe: () => () => {} }
  )
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => ({}),
  localPreflightContextKey: () => 'test'
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./use-jira-source-connection', () => ({
  useJiraSourceConnection: () => ({ status: null, loaded: false })
}))
vi.mock('./use-jira-url-source', () => ({ useJiraUrlSource: mocks.readJiraSource }))
vi.mock('../use-jira-project-inventory', () => ({
  useJiraProjectInventory: () => ({ projects: [], connected: true, error: null, loading: false })
}))

function props(context?: TaskSourceContext): NormalizedWorkItemSourceSearchProps {
  return {
    repos: [],
    repoId: '',
    value: '',
    jiraSourceContext: null,
    linearSourceContext: context,
    disabled: false,
    textOnly: false,
    branchesEnabled: false,
    repoBackedSourcesDisabled: true,
    repoBackedSearchRepos: [],
    crossRepoSwitchTarget: 'task-source'
  }
}

describe('smart workspace explicit source connection', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.searchLinearIssues.mockResolvedValue([])
    mocks.state.listLinearIssues.mockResolvedValue({ items: [] })
    mocks.readStatus.mockResolvedValue({ connected: false, viewer: null })
    mocks.state.linearStatus = {
      connected: false,
      viewer: null,
      selectedWorkspaceId: 'focused-workspace'
    }
  })

  it("holds a pasted Linear URL while the repo host's status is still loading", async () => {
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    mocks.readStatus.mockReturnValue(new Promise(() => {}))
    const serverRepo: Repo = {
      id: 'server-repo',
      path: '/srv/app',
      displayName: 'app',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'runtime:remote'
    }
    const searchProps = {
      ...props(),
      repos: [serverRepo],
      repoId: serverRepo.id,
      value: 'https://linear.app/acme/issue/ENG-1/title'
    }
    const { result } = renderHook(() => useWorkItemSourceSearch(searchProps))
    await act(async () => {})
    expect(result.current.linearStatusChecked).toBe(false)
    expect(result.current.unresolvedLinearUrlIntent).toBe(true)
  })
  it('returns to Smart after losing a provider and does not resurrect its stale mode or rows', async () => {
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    mocks.state.searchLinearIssues.mockResolvedValue([referenceLinearIssue()])
    const searchProps = { ...props(), value: 'launch' }
    const { result, rerender } = renderHook(() => useWorkItemSourceSearch(searchProps))
    act(() => result.current.setMode('linear'))
    await waitFor(() => expect(result.current.rows.some((row) => row.kind === 'linear')).toBe(true))
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: false }
    rerender()
    await waitFor(() => expect(result.current.mode).toBe('smart'))
    expect(result.current.rows).toEqual([])
    mocks.state.searchLinearIssues.mockResolvedValue([])
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    rerender()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.mode).toBe('smart')
    expect(result.current.rows).toEqual([])
  })
})
