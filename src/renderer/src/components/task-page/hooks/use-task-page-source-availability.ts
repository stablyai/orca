import { useMemo } from 'react'

import { getSettingsFocusedExecutionHostId } from '../../../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../../../shared/execution-host-registry'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { JiraSite } from '../../../../../shared/jira-types'
import type { LinearWorkspace } from '../../../../../shared/linear/workspace-types'
import type { PreflightStatus } from '../../../../../preload/api-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import {
  getTaskSourceCacheScope,
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import type { TaskSourceHostAvailability } from '@/components/task-source-context-summary'
import {
  getRepoBackedProviderAvailability,
  type RuntimeProviderPreflightStatus
} from '@/components/task-source-provider-availability'
import { getTaskPageRepoSourceContext } from '../source/repo-source-context'
import { getTaskSourceHostAvailabilityForHost } from '../source/task-source-host-availability'

export function useTaskPageSourceAvailability({
  taskSource,
  selectedRepos,
  hostRegistryById,
  preflightStatus,
  preflightStatusCurrent,
  preflightStatusChecked,
  runtimePreflightStatusByHostId,
  taskSourceRepoContexts,
  settings,
  selectedLinearWorkspace,
  selectedLinearWorkspaceId,
  selectedJiraSite,
  selectedJiraSiteId,
  linearListInvalidationToken,
  providerRuntimeContextKey
}: {
  taskSource: TaskProvider
  selectedRepos: Repo[]
  hostRegistryById: ReadonlyMap<TaskSourceContext['hostId'], ExecutionHostRegistryEntry>
  preflightStatus: PreflightStatus | null
  preflightStatusCurrent: boolean
  preflightStatusChecked: boolean
  runtimePreflightStatusByHostId: ReadonlyMap<
    TaskSourceContext['hostId'],
    RuntimeProviderPreflightStatus
  >
  taskSourceRepoContexts: TaskSourceContext[]
  settings: GlobalSettings | null
  selectedLinearWorkspace: LinearWorkspace | null
  selectedLinearWorkspaceId: string | null
  selectedJiraSite: JiraSite | null
  selectedJiraSiteId: string | null
  linearListInvalidationToken: { scope: string; version: number }
  providerRuntimeContextKey: string
}) {
  const taskSourceHostAvailability = useMemo<TaskSourceHostAvailability[]>(() => {
    if (taskSource !== 'github' && taskSource !== 'gitlab') {
      return []
    }
    return [
      ...taskSourceRepoContexts.flatMap((context) => {
        const host = hostRegistryById.get(context.hostId)
        const availability = getTaskSourceHostAvailabilityForHost(host, context.hostId)
        return availability ? [availability] : []
      }),
      ...getRepoBackedProviderAvailability({
        provider: taskSource,
        contexts: taskSourceRepoContexts,
        preflightStatus,
        preflightReady: preflightStatusCurrent && preflightStatusChecked,
        runtimePreflightStatusByHostId
      })
    ]
  }, [
    hostRegistryById,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusCurrent,
    runtimePreflightStatusByHostId,
    taskSource,
    taskSourceRepoContexts
  ])
  const accountBackedTaskSourceHostId = useMemo(
    () => getSettingsFocusedExecutionHostId(settings),
    [settings]
  )
  const fallbackTaskSourceProjectId = useMemo(() => {
    const firstRepoContext = selectedRepos
      .map((repo) => getTaskPageRepoSourceContext(repo, 'github'))
      .find((context): context is TaskSourceContext => context !== null)
    return firstRepoContext?.projectId ?? 'account-backed-task-source'
  }, [selectedRepos])
  const linearTaskSourceContext = useMemo(
    () =>
      normalizeTaskSourceContext({
        provider: 'linear',
        projectId: fallbackTaskSourceProjectId,
        hostId: accountBackedTaskSourceHostId,
        providerIdentity: {
          provider: 'linear',
          workspaceId:
            selectedLinearWorkspaceId && selectedLinearWorkspaceId !== 'all'
              ? selectedLinearWorkspaceId
              : null,
          workspaceName:
            selectedLinearWorkspace?.organizationName ??
            selectedLinearWorkspace?.displayName ??
            null
        },
        accountLabel:
          selectedLinearWorkspace?.organizationName ?? selectedLinearWorkspace?.displayName ?? null
      }),
    [
      accountBackedTaskSourceHostId,
      fallbackTaskSourceProjectId,
      selectedLinearWorkspace,
      selectedLinearWorkspaceId
    ]
  )
  // Why: only react to invalidation tokens for this TaskPage source scope.
  const linearListInvalidationVersionForSource = useMemo(() => {
    const scope = linearTaskSourceContext
      ? getTaskSourceCacheScope(linearTaskSourceContext)
      : 'local'
    return linearListInvalidationToken.scope === scope ? linearListInvalidationToken.version : 0
  }, [linearListInvalidationToken, linearTaskSourceContext])
  const jiraTaskSourceContext = useMemo(
    () =>
      normalizeTaskSourceContext({
        provider: 'jira',
        projectId: fallbackTaskSourceProjectId,
        hostId: accountBackedTaskSourceHostId,
        providerIdentity: {
          provider: 'jira',
          siteId: selectedJiraSiteId && selectedJiraSiteId !== 'all' ? selectedJiraSiteId : null,
          siteUrl: selectedJiraSite?.siteUrl ?? null
        },
        accountLabel: selectedJiraSite?.displayName ?? selectedJiraSite?.siteUrl ?? null
      }),
    [
      accountBackedTaskSourceHostId,
      fallbackTaskSourceProjectId,
      selectedJiraSite,
      selectedJiraSiteId
    ]
  )
  const jiraTaskSourceScopeKey = jiraTaskSourceContext
    ? getTaskSourceCacheScope(jiraTaskSourceContext)
    : providerRuntimeContextKey
  const accountBackedTaskSourceHostAvailability = useMemo<TaskSourceHostAvailability[]>(() => {
    if (taskSource !== 'linear' && taskSource !== 'jira') {
      return []
    }
    const host = hostRegistryById.get(accountBackedTaskSourceHostId)
    const availability = getTaskSourceHostAvailabilityForHost(host, accountBackedTaskSourceHostId)
    return availability ? [availability] : []
  }, [accountBackedTaskSourceHostId, hostRegistryById, taskSource])

  return {
    taskSourceHostAvailability,
    accountBackedTaskSourceHostId,
    fallbackTaskSourceProjectId,
    linearTaskSourceContext,
    linearListInvalidationVersionForSource,
    jiraTaskSourceContext,
    jiraTaskSourceScopeKey,
    accountBackedTaskSourceHostAvailability
  }
}
