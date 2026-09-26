import type { TaskPageRuntimeHostsModel } from './use-task-page-runtime-hosts'
import { useCallback, useMemo } from 'react'
import type { Repo } from '../../../shared/repo-types'
import {
  getTaskPageRepoSourceContext,
  getTaskSourceHostAvailabilityForHost
} from './task-page-source-context'
import type { TaskSourceHostAvailability } from './task-source-context-summary'
import { getRepoBackedProviderAvailability } from '@/components/task-source-provider-availability'
import { getSettingsFocusedExecutionHostId } from '../../../shared/execution-host'
import {
  type TaskSourceContext,
  normalizeTaskSourceContext,
  getTaskSourceCacheScope
} from '../../../shared/task-source-context'
import { useTaskPageSourceSummary } from './use-task-page-source-summary'
export type TaskPageSourceAvailabilityPreludeModel = ReturnType<
  typeof useTaskPageSourceAvailabilityPrelude
>
export function useTaskPageSourceAvailabilityPrelude(model: TaskPageRuntimeHostsModel) {
  const {
    settings,
    preflightStatus,
    preflightStatusChecked,
    linearListInvalidationToken,
    providerRuntimeContextKey,
    preflightStatusCurrent,
    selectedRepos,
    selectedLinearWorkspaceId,
    selectedLinearWorkspace,
    selectedJiraSiteId,
    selectedJiraSite,
    taskSource,
    runtimePreflightStatusByHostId,
    taskSourceRepoContexts,
    hostRegistryById
  } = model
  const getTaskPickerRepoHostLabel = useCallback(
    (repo: Repo): string | null => {
      const provider = taskSource === 'gitlab' ? 'gitlab' : 'github'
      const context = getTaskPageRepoSourceContext(repo, provider)
      const hostId = context?.hostId ?? repo.executionHostId ?? 'local'
      return hostRegistryById.get(hostId)?.label ?? null
    },
    [hostRegistryById, taskSource]
  )
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
  const nextModel = model as typeof model & {
    getTaskPickerRepoHostLabel: typeof getTaskPickerRepoHostLabel
    taskSourceHostAvailability: typeof taskSourceHostAvailability
    accountBackedTaskSourceHostId: typeof accountBackedTaskSourceHostId
    fallbackTaskSourceProjectId: typeof fallbackTaskSourceProjectId
    linearTaskSourceContext: typeof linearTaskSourceContext
    linearListInvalidationVersionForSource: typeof linearListInvalidationVersionForSource
    jiraTaskSourceContext: typeof jiraTaskSourceContext
    jiraTaskSourceScopeKey: typeof jiraTaskSourceScopeKey
    accountBackedTaskSourceHostAvailability: typeof accountBackedTaskSourceHostAvailability
  }
  nextModel.getTaskPickerRepoHostLabel = getTaskPickerRepoHostLabel
  nextModel.taskSourceHostAvailability = taskSourceHostAvailability
  nextModel.accountBackedTaskSourceHostId = accountBackedTaskSourceHostId
  nextModel.fallbackTaskSourceProjectId = fallbackTaskSourceProjectId
  nextModel.linearTaskSourceContext = linearTaskSourceContext
  nextModel.linearListInvalidationVersionForSource = linearListInvalidationVersionForSource
  nextModel.jiraTaskSourceContext = jiraTaskSourceContext
  nextModel.jiraTaskSourceScopeKey = jiraTaskSourceScopeKey
  nextModel.accountBackedTaskSourceHostAvailability = accountBackedTaskSourceHostAvailability
  return nextModel
}
export function useTaskPageSourceAvailability(model: TaskPageRuntimeHostsModel) {
  const preludeModel = useTaskPageSourceAvailabilityPrelude(model)
  return useTaskPageSourceSummary(preludeModel)
}
export type TaskPageSourceAvailabilityModel = ReturnType<typeof useTaskPageSourceAvailability>
