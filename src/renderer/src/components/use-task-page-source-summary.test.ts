// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import type { Repo } from '../../../shared/repo-types'
import type { TaskPageSourceRepoScopeModel } from './use-task-page-source-repo-scope'
import { useTaskPageSourceSummary } from './use-task-page-source-summary'

const localHost: ExecutionHostRegistryEntry = {
  id: 'local',
  kind: 'local',
  label: 'This Mac',
  detail: 'local',
  health: 'local'
}
const builderHost: ExecutionHostRegistryEntry = {
  id: 'ssh:builder',
  kind: 'ssh',
  label: 'Builder',
  detail: 'builder',
  health: 'disconnected',
  connectionStatus: 'disconnected'
}

function repoOn(id: string, host: 'local' | 'builder'): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: 0,
    ...(host === 'builder'
      ? { connectionId: 'builder', executionHostId: 'ssh:builder' }
      : { executionHostId: 'local' })
  }
}

function renderSummary(scope: {
  taskSource: 'github' | 'gitlab'
  githubTaskRepos: Repo[]
  gitlabTaskRepos: Repo[]
}) {
  const hosts = [localHost, builderHost]
  const model = {
    ...scope,
    selectedRepos: [...new Set([...scope.githubTaskRepos, ...scope.gitlabTaskRepos])],
    preflightStatus: null,
    preflightStatusChecked: false,
    preflightStatusCurrent: false,
    preflightDescribesDesktop: false,
    selectedLinearWorkspace: null,
    selectedJiraSite: null,
    sourceOptions: [
      { id: 'github', label: 'GitHub' },
      { id: 'gitlab', label: 'GitLab' }
    ],
    runtimePreflightStatusByHostId: new Map(),
    taskSourceRepoContexts: [],
    hostRegistryById: new Map(hosts.map((host) => [host.id, host])),
    hostLabelById: new Map(hosts.map((host) => [host.id, host.label])),
    taskSourceHostAvailability: [],
    accountBackedTaskSourceHostId: 'local',
    accountBackedTaskSourceHostAvailability: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The summary reads only the fields stubbed above.
  const scopedModel = model as unknown as TaskPageSourceRepoScopeModel
  return renderHook(() => useTaskPageSourceSummary(scopedModel)).result.current
}

describe('useTaskPageSourceSummary', () => {
  it("ignores a down host that holds only the other forge's projects", () => {
    const gitlabOnBuilder = repoOn('gitlab', 'builder')
    const summary = renderSummary({
      taskSource: 'github',
      githubTaskRepos: [repoOn('github', 'local')],
      gitlabTaskRepos: [gitlabOnBuilder]
    })

    expect(summary.taskSourceAvailabilityNoticeByProvider.github).toBeUndefined()
    expect(summary.taskSourceAvailabilityNotice).toBeNull()
    expect(summary.taskSourceAvailabilityNoticeByProvider.gitlab?.blocking).toBe(true)
  })

  it("blocks GitHub when its only project's host is down, whatever else is selected", () => {
    const summary = renderSummary({
      taskSource: 'github',
      githubTaskRepos: [repoOn('github', 'builder')],
      gitlabTaskRepos: [repoOn('gitlab-a', 'local'), repoOn('gitlab-b', 'local')]
    })

    expect(summary.taskSourceAvailabilityNoticeByProvider.github?.blocking).toBe(true)
    expect(summary.taskSourceAvailabilityNotice).toBe(
      summary.taskSourceAvailabilityNoticeByProvider.github
    )
  })
})
