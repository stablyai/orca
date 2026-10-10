// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { NormalizedWorkItemSourceSearchProps } from './smart-workspace-name-field-model'
import { useWorkItemSourceSearch } from './use-work-item-source-search'
import { referenceLinearIssue } from '../sidebar/workspace-reference-fixtures.test-support'
import { useWorkItemSourceFoundation } from './use-work-item-source-foundation'
import { useSmartWorkspaceSecondarySearches } from './use-smart-workspace-secondary-searches'

const mocks = vi.hoisted(() => ({
  readStatus: vi.fn(),
  readJiraSource: vi.fn(() => ({ intent: false })),
  state: {
    addRepo: vi.fn(),
    checkLinearConnection: vi.fn(),
    linearStatus: { connected: false, viewer: null, selectedWorkspaceId: 'focused-workspace' },
    linearStatusChecked: true,
    settings: null,
    preflightStatus: null,
    preflightStatusChecked: true,
    preflightStatusContextKey: 'test',
    refreshPreflightStatus: vi.fn(),
    searchLinearIssues: vi.fn<
      (query: string, limit: number, options: unknown) => Promise<LinearIssue[]>
    >(async () => [])
  }
}))
vi.mock('@/runtime/runtime-linear-client', () => ({ linearStatus: mocks.readStatus }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
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

const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'linear',
  projectId: 'project-1',
  hostId: 'runtime:saved-host',
  repoId: null,
  providerIdentity: null,
  accountLabel: null
}

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
    mocks.state.linearStatus = {
      connected: false,
      viewer: null,
      selectedWorkspaceId: 'focused-workspace'
    }
  })

  it('exposes Linear on a connected saved host while the focused runtime is disconnected', async () => {
    mocks.readStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'source-workspace'
    })
    const fieldProps = props(source)
    const { result } = renderHook(() => {
      const foundation = useWorkItemSourceFoundation(fieldProps)
      useSmartWorkspaceSecondarySearches({
        foundation,
        shouldQueryLinear: foundation.linearAvailable,
        linearQuery: 'launch',
        linearUrlIntent: null,
        linearUrlIntentOwnsInput: false,
        shouldQueryJira: false,
        jiraSearchQuery: null
      })
      return foundation
    })
    await waitFor(() =>
      expect(result.current.availableModes.some((mode) => mode.id === 'linear')).toBe(true)
    )
    expect(result.current.linearSourceContext).toBe(source)
    expect(result.current.linearStatus.connected).toBe(true)
    expect(mocks.state.searchLinearIssues).toHaveBeenCalledWith('launch', 12, {
      sourceContext: source,
      workspaceId: 'source-workspace'
    })
    expect(mocks.readStatus).toHaveBeenCalledWith(source)
    expect(mocks.state.checkLinearConnection).not.toHaveBeenCalled()
    expect(mocks.state.linearStatus.connected).toBe(false)
  })

  it('hides disconnected saved-host Linear even when the focused runtime is connected', async () => {
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    mocks.readStatus.mockResolvedValue({ connected: false, viewer: null })
    const fieldProps = props(source)
    const { result } = renderHook(() => useWorkItemSourceFoundation(fieldProps))
    await waitFor(() => expect(result.current.linearStatusChecked).toBe(true))
    expect(result.current.availableModes.some((mode) => mode.id === 'linear')).toBe(false)
    expect(result.current.linearStatus.connected).toBe(false)
  })

  it('retains focused runtime status and avoids a new status read without an override', async () => {
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    const fieldProps = props()
    const { result } = renderHook(() => useWorkItemSourceFoundation(fieldProps))
    await act(async () => {})
    expect(result.current.availableModes.some((mode) => mode.id === 'linear')).toBe(true)
    expect(result.current.linearStatus).toBe(mocks.state.linearStatus)
    expect(mocks.readStatus).not.toHaveBeenCalled()
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

  it.each([false, true])(
    'allows Jira URL resolution only while sourceSelected=%s is false',
    (sourceSelected) => {
      const fieldProps = {
        ...props(),
        sourceSelected,
        value: 'https://company.atlassian.net/browse/ENG-1'
      }
      renderHook(() => useWorkItemSourceFoundation(fieldProps))
      expect(mocks.readJiraSource).toHaveBeenLastCalledWith(
        expect.objectContaining({ enabled: !sourceSelected })
      )
    }
  )
})
