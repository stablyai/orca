// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useJiraProjectInventory } from '@/components/use-jira-project-inventory'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import type { JiraIssue, JiraProject } from '../../../../shared/jira/jira-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
} from '../../../../shared/protocol-version'

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
})
