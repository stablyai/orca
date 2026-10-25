import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { createCmdJTaskSearchRequests } from './task-search-requests'
import { jiraTaskIssue } from './task-search.test-fixture'
import { makeRepo } from '../worktree-jump-palette-test-fixtures'
import { linearSearchIssuesForTarget, linearStatusForTarget } from '@/runtime/runtime-linear-client'
import { jiraSearchIssuesForTarget, jiraStatusForTarget } from '@/runtime/runtime-jira-client'
import { createRuntimeGitLabApi } from '@/runtime/runtime-gitlab-api'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'
import type { ExecutionHostId } from '../../../../shared/execution-host'

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearStatusForTarget: vi.fn(),
  linearSearchIssuesForTarget: vi.fn()
}))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraSearchIssuesForTarget: vi.fn(),
  jiraStatusForTarget: vi.fn()
}))
vi.mock('@/runtime/gitlab-owner-api', () => ({ gitLabApiFor: vi.fn() }))
const initial = useAppStore.getInitialState()
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.resetAllMocks()
})
function requests(
  providers: ('jira' | 'linear' | 'github' | 'gitlab')[],
  hostIds: string[] = [],
  repos = [makeRepo()],
  repoIds: string[] = [],
  accountBackedTaskSourceHostId: ExecutionHostId = 'local'
) {
  return createCmdJTaskSearchRequests({
    query: 'login redirect',
    settings: createGlobalSettingsFixture({ visibleTaskProviders: providers }),
    accountBackedTaskSourceHostId,
    repos,
    filter: { hostIds, repoIds },
    hostLabels: new Map(),
    signal: new AbortController().signal
  })
}

it('binds Jira results to the returned account rather than the active site', async () => {
  vi.mocked(jiraSearchIssuesForTarget).mockResolvedValue([jiraTaskIssue])
  vi.mocked(jiraStatusForTarget).mockResolvedValue({
    connected: true,
    viewer: null,
    selectedSiteId: 'all',
    sites: [
      {
        id: 'other-site',
        siteUrl: 'https://other.atlassian.net',
        email: 'other@example.com',
        displayName: 'Other account',
        accountId: 'other-account'
      }
    ]
  })
  const result = await requests(['jira'])[0]?.run()
  expect(result?.[0]?.sourceContext).toMatchObject({
    hostId: 'local',
    accountLabel: 'other@example.com',
    providerIdentity: { siteId: 'other-site', projectKey: 'DEMO' }
  })
  expect(jiraSearchIssuesForTarget).toHaveBeenCalledWith(
    { kind: 'local' },
    'text ~ "login redirect*"',
    12,
    'all',
    expect.any(AbortSignal)
  )
})

it('scopes Linear queries to the explicit runtime and selected workspace', async () => {
  vi.mocked(linearStatusForTarget).mockResolvedValue({
    connected: true,
    viewer: null,
    selectedWorkspaceId: 'workspace-a'
  })
  vi.mocked(linearSearchIssuesForTarget).mockResolvedValue([])
  await requests(['linear'], ['runtime:source'], [])[0]?.run()
  expect(linearSearchIssuesForTarget).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'source' },
    'login redirect',
    12,
    'workspace-a'
  )
  expect(requests(['linear', 'jira'], ['ssh:remote'], [])).toMatchObject([
    { id: 'jira:local', provider: 'jira' }
  ])
})

it.each(['linear', 'jira'] as const)(
  'keeps %s on the captured palette host when the default host changes during status loading',
  async (provider) => {
    const switchDefaultHost = (): void =>
      useAppStore.setState({
        settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'other-host' })
      })
    if (provider === 'linear') {
      vi.mocked(linearStatusForTarget).mockImplementation(async () => {
        switchDefaultHost()
        return { connected: true, viewer: null, selectedWorkspaceId: 'workspace-a' }
      })
      vi.mocked(linearSearchIssuesForTarget).mockResolvedValue([])
    } else {
      vi.mocked(jiraStatusForTarget).mockImplementation(async () => {
        switchDefaultHost()
        return { connected: true, viewer: null, selectedSiteId: 'other-site' }
      })
      vi.mocked(jiraSearchIssuesForTarget).mockResolvedValue([jiraTaskIssue])
    }
    const [request] = requests([provider], [], [], [], 'runtime:palette-owner')
    expect(request?.id).toBe(`${provider}:runtime:palette-owner`)
    const results = await request?.run()
    const target = { kind: 'environment', environmentId: 'palette-owner' }
    if (provider === 'linear') {
      expect(linearStatusForTarget).toHaveBeenCalledWith(target)
      expect(linearSearchIssuesForTarget).toHaveBeenCalledWith(
        target,
        'login redirect',
        12,
        'workspace-a'
      )
    } else {
      expect(jiraStatusForTarget).toHaveBeenCalledWith(target)
      expect(jiraSearchIssuesForTarget).toHaveBeenCalledWith(
        target,
        'text ~ "login redirect*"',
        12,
        'other-site',
        expect.any(AbortSignal)
      )
      expect(results?.[0]?.sourceContext.hostId).toBe('runtime:palette-owner')
    }
  }
)

it('searches desktop-owned Jira for an SSH repository filter and retains the repository seed', async () => {
  vi.mocked(jiraStatusForTarget).mockResolvedValue({
    connected: true,
    viewer: null,
    selectedSiteId: 'other-site'
  })
  vi.mocked(jiraSearchIssuesForTarget).mockResolvedValue([jiraTaskIssue])
  const remoteRepo = { ...makeRepo(), id: 'remote-repo', executionHostId: 'ssh:remote' as const }
  for (const hostIds of [['ssh:remote'], []]) {
    const scoped = requests(['jira'], hostIds, [makeRepo(), remoteRepo], [remoteRepo.id])
    expect(scoped).toHaveLength(1)
    const results = await scoped[0]?.run()
    expect(results?.[0]).toMatchObject({
      initialRepoId: remoteRepo.id,
      sourceContext: { hostId: 'local', repoId: remoteRepo.id }
    })
  }
  expect(jiraStatusForTarget).toHaveBeenCalledWith({ kind: 'local' })
  expect(jiraSearchIssuesForTarget).toHaveBeenCalledWith(
    { kind: 'local' },
    'text ~ "login redirect*"',
    12,
    'other-site',
    expect.any(AbortSignal)
  )
})

it('queries Jira once per credential host while preserving runtime ownership', async () => {
  vi.mocked(jiraStatusForTarget).mockResolvedValue({ connected: true, viewer: null })
  vi.mocked(jiraSearchIssuesForTarget).mockResolvedValue([])
  const scoped = requests(['jira'], ['ssh:first', 'local', 'ssh:second', 'runtime:source'], [])
  expect(scoped.map((request) => request.id)).toEqual(['jira:local', 'jira:runtime:source'])
  await Promise.all(scoped.map((request) => request.run()))
  expect(jiraStatusForTarget).toHaveBeenCalledTimes(2)
  expect(jiraStatusForTarget).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'source' })
  expect(jiraSearchIssuesForTarget).toHaveBeenCalledTimes(2)
})

it('routes GitHub search through the repo owner with an open-issue query', async () => {
  const fetch = vi.fn().mockResolvedValue([])
  useAppStore.setState({ fetchWorkItems: fetch, preflightStatusChecked: false })
  const repo = { ...makeRepo(), executionHostId: 'runtime:forge' as const }
  await requests(['github'], ['runtime:forge'], [repo])[0]?.run()
  expect(fetch).toHaveBeenCalledWith(
    repo.id,
    repo.path,
    12,
    'is:issue is:open login redirect',
    expect.objectContaining({
      sourceContext: expect.objectContaining({ hostId: 'runtime:forge', repoId: repo.id })
    })
  )
})

it('uses GitLab combined search and never includes merge requests in task results', async () => {
  const listWorkItems = vi.fn().mockResolvedValue({
    items: [{ type: 'mr', number: 1, title: 'login redirect', state: 'opened' }]
  })
  vi.mocked(gitLabApiFor).mockReturnValue({
    ...createRuntimeGitLabApi({
      call: async () => {
        throw new Error('Unexpected GitLab call')
      },
      supportsCapability: async () => false
    }),
    listWorkItems
  })
  useAppStore.setState({ preflightStatusChecked: false })
  const repo = { ...makeRepo(), connectionId: 'remote' }
  const result = await requests(['gitlab'], ['ssh:remote'], [repo])[0]?.run()
  expect(gitLabApiFor).toHaveBeenCalledWith(
    expect.objectContaining({
      repoOwnerExecutionHostId: 'ssh:remote',
      sourceContext: expect.objectContaining({ hostId: 'ssh:remote' })
    })
  )
  expect(listWorkItems).toHaveBeenCalledWith(
    expect.objectContaining({ state: 'opened', query: 'login redirect', perPage: 12 })
  )
  expect(result).toEqual([])
})

it('does not search disconnected account integrations or folder repositories', async () => {
  vi.mocked(linearStatusForTarget).mockResolvedValue({ connected: false, viewer: null })
  vi.mocked(jiraStatusForTarget).mockResolvedValue({ connected: false, viewer: null })
  for (const request of requests(['linear', 'jira'])) {
    expect(await request.run()).toEqual([])
  }
  expect(linearSearchIssuesForTarget).not.toHaveBeenCalled()
  expect(jiraSearchIssuesForTarget).not.toHaveBeenCalled()
  expect(requests(['github', 'gitlab'], [], [{ ...makeRepo(), kind: 'folder' }])).toEqual([])
})
