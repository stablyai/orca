// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { RepositoryJiraProjectSection } from '@/components/settings/repository/RepositoryJiraProjectSection'
import { useWorkItemSourceSearch } from '@/components/new-workspace/use-work-item-source-search'
import { useJiraProjectInventory } from '@/components/use-jira-project-inventory'
import { getRepoWorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import type { JiraIssue, JiraProject } from '../../../../shared/jira-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
} from '../../../../shared/protocol-version'
import * as decisions from './composer-decisions'
import { useComposerTargetState } from './composer-target-state'
import { useComposerExternalSync } from './composer-external-sync'
import { useComposerSourceState } from './composer-source-state'
import { useComposerSubmitOrchestration } from './composer-submit-orchestration'

const originalState = useAppStore.getState()
let originalApi: PropertyDescriptor | undefined
const alpha = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
const beta = { ...alpha, key: 'BET', name: 'Beta', siteId: 'site-b' }
const localRepo: Repo = {
  id: 'local-repo',
  path: '/local-repo',
  displayName: 'Local project',
  badgeColor: '',
  addedAt: 0,
  kind: 'folder'
}
const executionRepo: Repo = {
  ...localRepo,
  id: 'ssh-repo',
  path: '/ssh-repo',
  displayName: 'SSH project',
  connectionId: 'execution-b'
}
const issue: JiraIssue = {
  id: 'issue-a',
  key: 'ALP-1',
  siteId: alpha.siteId,
  title: 'Fix export',
  url: 'https://jira-a.example.invalid/browse/ALP-1',
  project: alpha,
  issueType: { id: 'task', name: 'Task' },
  status: {
    id: 'open',
    name: 'Open',
    categoryKey: 'new',
    categoryName: 'To do',
    colorName: 'blue-gray'
  },
  labels: [],
  updatedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z'
}
const status = vi.fn<Window['api']['jira']['status']>()
const projects = vi.fn<Window['api']['jira']['listProjects']>()
const search = vi.fn<Window['api']['jira']['searchIssues']>()
const update = vi.fn<Window['api']['repos']['update']>()
const create = vi.fn<Window['api']['worktrees']['create']>()
const runtimeCall = vi.fn<Window['api']['runtimeEnvironments']['call']>()

function seedRepos(repos: readonly Repo[] = [localRepo, executionRepo], configured = true) {
  const projection = projectHostSetupProjectionFromRepos(repos)
  useAppStore.setState({
    settings: null,
    repos,
    projects: [...projection.projects],
    projectHostSetups: [...projection.setups],
    projectGroups: [],
    newWorkspaceDraft: null,
    worktreesByRepo: {},
    sparsePresetsByRepo: {},
    workspaceHostScope: 'all',
    sshTargetLabels: configured ? new Map([['execution-b', 'Execution B']]) : new Map(),
    sshConnectionStates: new Map([
      [
        'execution-b',
        {
          targetId: 'execution-b',
          status: 'connected',
          connectionGeneration: 1,
          reconnectAttempt: 0,
          error: null
        }
      ]
    ]),
    detectedAgentIds: [],
    remoteDetectedAgentIds: { 'execution-b': [] },
    jiraSearchCache: {},
    jiraConnectionRevisions: {},
    jiraStatus: { connected: false, viewer: null },
    jiraStatusChecked: true,
    linearStatus: { connected: false, viewer: null },
    linearStatusChecked: true,
    pendingWorktreeCreations: {},
    activePendingCreationId: null,
    refreshPreflightStatus: vi.fn(async () => {}),
    ensureDetectedAgents: vi.fn(async () => []),
    ensureRemoteDetectedAgents: vi.fn(async () => [])
  })
  return projection
}

function MappedRepositorySetting() {
  const repo = useAppStore((state) => state.repos.find((row) => row.id === executionRepo.id))
  if (!repo) {
    throw new Error('Expected execution repository')
  }
  return (
    <RepositoryJiraProjectSection
      repo={repo}
      updateRepo={(id, updates) =>
        useAppStore.getState().updateRepo(id, updates, { hostId: 'ssh:execution-b' })
      }
      forceVisible
    />
  )
}

function renderMappedComposer(configured = true) {
  const projection = seedRepos(useAppStore.getState().repos, configured)
  const mapped = useAppStore.getState().repos.find((repo) => repo.id === executionRepo.id)
  if (!mapped) {
    throw new Error('Expected mapped repository')
  }
  return renderHook(() => {
    const target = useComposerTargetState(
      {
        persistDraft: false,
        initialRepoId: mapped.id,
        initialWorkspaceTarget: getRepoWorkspaceCreationTargetHint(mapped, projection.setups)
      },
      decisions
    )
    const external = useComposerExternalSync(target)
    const source = useComposerSourceState(target, external)
    const submit = useComposerSubmitOrchestration(target, external, source)
    const lookup = useWorkItemSourceSearch({
      repos: target.composerTargetStore.repos,
      repoId: target.initialTargetState.repoId,
      selectedRepo: target.runtimeTargetSelection.selectedRepo ?? null,
      jiraSourceContext: target.sourceContextState.smartNameJiraSourceContext,
      value: 'export',
      branchesEnabled: false,
      repoBackedSourcesDisabled: true
    })
    return { target, source, submit, lookup }
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  clearRuntimeCompatibilityCacheForTests()
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  status.mockResolvedValue({
    connected: true,
    viewer: { accountId: 'account-a', displayName: 'Jira A', email: null },
    selectedSiteId: 'all',
    sites: [
      {
        id: alpha.siteId,
        siteUrl: 'https://jira-a.example.invalid',
        email: '',
        displayName: 'Jira A',
        accountId: 'account-a'
      }
    ]
  })
  projects.mockResolvedValue([alpha, beta])
  search.mockResolvedValue([issue])
  update.mockImplementation(async ({ repoId, updates }) => {
    const repo = useAppStore.getState().repos.find((row) => row.id === repoId)
    if (!repo) {
      throw new Error('Unknown synthetic execution repository')
    }
    return { ...repo, defaultJiraProject: updates.defaultJiraProject }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      jira: {
        status,
        readStatus: status,
        listProjects: projects,
        searchIssues: search,
        cancelSearchIssues: vi
          .fn<Window['api']['jira']['cancelSearchIssues']>()
          .mockResolvedValue(undefined)
      },
      repos: { update },
      worktrees: {
        create,
        listRetiredNames: vi
          .fn<Window['api']['worktrees']['listRetiredNames']>()
          .mockResolvedValue(EMPTY_RETIRED_NAME_REGISTRY)
      },
      runtimeEnvironments: { call: runtimeCall }
    }
  })
  seedRepos()
})

afterEach(() => {
  cleanup()
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState(originalState, true)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('mapped Jira owner A to SSH execution owner B', () => {
  it('discovers A, verifies B save echo, queries A and starts B with the bound Jira link', async () => {
    render(<MappedRepositorySetting />)
    const picker = screen.getByRole('combobox', { name: 'Default Jira project' })
    await waitFor(() => expect(picker.hasAttribute('disabled')).toBe(false))
    expect(projects).toHaveBeenCalledWith({ siteId: 'all' })
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: 'ALP · Alpha' }))
    await waitFor(() => expect(picker.textContent).toContain('ALP · Alpha'))
    expect(update).toHaveBeenCalledExactlyOnceWith({
      repoId: executionRepo.id,
      hostId: 'ssh:execution-b',
      updates: { defaultJiraProject: alpha }
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(useAppStore.getState().repos[0].defaultJiraProject).toBeUndefined()

    const { result } = renderMappedComposer()
    await waitFor(() => expect(result.current.lookup.jiraSourceConnected).toBe(true))
    expect(result.current.lookup.jiraConnectionStatus?.viewer?.accountId).toBe('account-a')
    expect(result.current.lookup.jiraSourceContext?.hostId).toBe('local')
    expect(result.current.target.runtimeTargetSelection.selectedRepoExecutionHostId).toBe(
      'ssh:execution-b'
    )
    act(() => result.current.lookup.setMode('jira'))
    await waitFor(() => expect(result.current.lookup.jiraIssues).toEqual([issue]))
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        jql: 'project = "10" AND (text ~ "export*")',
        siteId: alpha.siteId,
        limit: 12
      })
    )
    const row = result.current.lookup.rows.find((entry) => entry.kind === 'jira')
    if (!row || row.kind !== 'jira') {
      throw new Error('Expected discovered Jira row')
    }
    const linked = result.current.lookup.resolveRow(row)
    const boundSource = linked?.taskSourceContext
    if (!boundSource) {
      throw new Error('Expected account-bound Jira row')
    }
    act(() =>
      result.current.source.issueSourceActions.handleSmartJiraIssueSelect(row.issue, boundSource)
    )
    act(() => result.current.source.projectTargetActions.handleProjectChange('repo:local-repo'))
    expect(result.current.target.runtimeTargetSelection.selectedRepo).toBe(localRepo)
    act(() => result.current.source.projectTargetActions.handleProjectChange('repo:ssh-repo'))
    expect(result.current.target.runtimeTargetSelection.selectedRepo?.connectionId).toBe(
      'execution-b'
    )
    expect(result.current.target.sourceContextState.taskSourceContext).toMatchObject({
      hostId: 'local',
      providerIdentity: { provider: 'jira', siteId: alpha.siteId, projectKey: alpha.key }
    })
    const response = Promise.withResolvers<CreateWorktreeResult>()
    create.mockReturnValueOnce(response.promise)
    await act(async () => result.current.submit.quickSubmitAction.submitQuick(null))
    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: executionRepo.id,
        setupDecision: 'skip',
        linkedWorkItem: expect.objectContaining({ provider: 'jira', jiraIdentifier: issue.key }),
        linkedTaskSourceContext: boundSource
      })
    )
    const pending = Object.values(useAppStore.getState().pendingWorktreeCreations)[0]
    expect(pending.request.workspaceRunContext).toMatchObject({
      hostId: 'ssh:execution-b',
      repoId: executionRepo.id,
      path: executionRepo.path
    })
    expect(runtimeCall).not.toHaveBeenCalled()
    // Cancel the presentation so this transport test does not seed or activate terminals.
    act(() => useAppStore.getState().removePendingWorktreeCreation(pending.creationId))
    await act(async () =>
      response.resolve({ worktree: makeWorktree({ id: 'created-b', repoId: executionRepo.id }) })
    )
    await waitFor(() =>
      expect(useAppStore.getState().worktreesByRepo[executionRepo.id][0]).toMatchObject({
        id: 'created-b',
        hostId: 'ssh:execution-b'
      })
    )
  })

  it('rejects an ignored save echo before exposing a default to the composer', async () => {
    update.mockResolvedValue(executionRepo)
    render(<MappedRepositorySetting />)
    const picker = screen.getByRole('combobox', { name: 'Default Jira project' })
    await waitFor(() => expect(picker.hasAttribute('disabled')).toBe(false))
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: 'ALP · Alpha' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Update this runtime')
    )
    const { result } = renderMappedComposer()
    expect(result.current.lookup.jiraProject).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('restores B mapping after target changes but refuses an unavailable execution host', async () => {
    seedRepos([localRepo, { ...executionRepo, defaultJiraProject: alpha }])
    const { result } = renderMappedComposer()
    expect(result.current.lookup.jiraProject).toEqual(alpha)
    act(() => result.current.source.projectTargetActions.handleProjectChange('repo:local-repo'))
    expect(result.current.lookup.jiraProject).toBeNull()
    act(() => result.current.source.projectTargetActions.handleProjectChange('repo:ssh-repo'))
    expect(result.current.lookup.jiraProject).toEqual(alpha)
    act(() => useAppStore.setState({ sshTargetLabels: new Map() }))
    expect(result.current.target.runtimeTargetSelection.selectedWorkspaceTarget.status).toBe(
      'unavailable'
    )
    await act(async () => result.current.submit.quickSubmitAction.submitQuick(null))
    expect(create).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingWorktreeCreations).toEqual({})
  })

  it('drops the first A inventory after account selection changes A → B → A', async () => {
    const firstA = Promise.withResolvers<JiraProject[]>()
    projects.mockReturnValueOnce(firstA.promise).mockResolvedValueOnce([beta])
    const accountA: RuntimeClientTarget = { kind: 'local' }
    const accountB: RuntimeClientTarget = { kind: 'environment', environmentId: 'jira-b' }
    runtimeCall.mockImplementation(async ({ method }) => {
      if (method === 'status.get') {
        return {
          id: 'compatibility-b',
          ok: true,
          _meta: { runtimeId: 'jira-b' },
          result: {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          }
        }
      }
      if (method === 'jira.status') {
        return {
          id: 'status-b',
          ok: true,
          _meta: { runtimeId: 'jira-b' },
          result: { connected: true, viewer: null }
        }
      }
      if (method === 'jira.listProjects') {
        return { id: 'inventory-b', ok: true, _meta: { runtimeId: 'jira-b' }, result: [alpha] }
      }
      throw new Error(`Unexpected synthetic Jira B method: ${method}`)
    })
    const initialProps: { source: RuntimeClientTarget } = { source: accountA }
    const { result, rerender } = renderHook(({ source }) => useJiraProjectInventory(source, true), {
      initialProps
    })
    await waitFor(() => expect(projects).toHaveBeenCalledOnce())
    rerender({ source: accountB })
    await waitFor(() => expect(result.current.projects).toEqual([alpha]))
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'jira-b',
        method: 'jira.listProjects',
        params: { siteId: 'all' }
      })
    )
    rerender({ source: accountA })
    await waitFor(() => expect(result.current.projects).toEqual([beta]))
    await act(async () => firstA.resolve([alpha]))
    expect(result.current.projects).toEqual([beta])
  })

  it('refuses an unresolved captured execution owner at the store transport boundary', async () => {
    const { result } = renderMappedComposer()
    const jiraSource = result.current.target.sourceContextState.smartNameJiraSourceContext
    if (!jiraSource) {
      throw new Error('Expected Jira source')
    }
    const createWorktree = useAppStore.getState().createWorktree
    const args: Parameters<typeof createWorktree> = [executionRepo.id, 'export']
    args[25] = {
      executionHostId: 'runtime:unresolved-owner',
      linkedTaskSourceContext: jiraSource
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(createWorktree(...args)).rejects.toThrow('The workspace host is unresolved')
      expect(create).not.toHaveBeenCalled()
      expect(runtimeCall).not.toHaveBeenCalled()
      expect(useAppStore.getState().worktreesByRepo).toEqual({})
    } finally {
      error.mockRestore()
    }
  })
})
