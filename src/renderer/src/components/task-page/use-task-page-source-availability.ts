import type { TaskPageRuntimeHostsModel } from './use-task-page-runtime-hosts'
import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { getJiraAccountLabel } from '@/lib/work-items/jira/jira-account-label'
import type { Repo } from '../../../../shared/repository/repo-types'
import { getTaskPageRepoSourceContext } from '../../lib/work-items/task-repo-source-context'
import { getTaskSourceHostAvailabilityForHost } from './task-page-source-context'
import type { TaskSourceHostAvailability } from './source-selection/task-source-context-summary'
import { getRepoBackedProviderAvailability } from '@/components/task-page/source-selection/task-source-provider-availability'
import {
  getSettingsFocusedExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { isRuntimeHostKnownUnreachable } from '@/runtime/hosts/connections/runtime-host-connection-state'
import {
  type TaskSourceContext,
  normalizeTaskSourceContext,
  getTaskSourceCacheScope
} from '../../../../shared/work-items/task-source-context'
import { useTaskPageSourceSummary } from './use-task-page-source-summary'
export type TaskPageSourceAvailabilityPreludeModel = ReturnType<
  typeof useTaskPageSourceAvailabilityPrelude
>
export function useTaskPageSourceAvailabilityPrelude(model: TaskPageRuntimeHostsModel) {
  const {
    settings,
    preflightStatus,
    preflightStatusChecked,
    providerRuntimeContextKey,
    preflightStatusCurrent,
    preflightDescribesDesktop,
    selectedRepos,
    selectedLinearWorkspaceId,
    selectedLinearWorkspace,
    selectedJiraSiteId,
    selectedJiraSite,
    taskSource,
    runtimePreflightStatusByHostId,
    taskSourceRepoContexts,
    hostRegistryById,
    runtimeStatusByEnvironmentId
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
        preflightReady:
          preflightStatusCurrent && preflightStatusChecked && preflightDescribesDesktop,
        runtimePreflightStatusByHostId
      })
    ]
  }, [
    hostRegistryById,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusCurrent,
    preflightDescribesDesktop,
    runtimePreflightStatusByHostId,
    taskSource,
    taskSourceRepoContexts
  ])
  // Lists skip these hosts instead of waiting out their connect bound; the key re-runs them when one returns.
  const unreachableTaskSourceHostIds = useMemo(
    () =>
      new Set(
        taskSourceRepoContexts.flatMap((context) => {
          const host = parseExecutionHostId(context.hostId)
          return host?.kind === 'runtime' &&
            isRuntimeHostKnownUnreachable(
              runtimeStatusByEnvironmentId.get(host.environmentId)?.snapshot
            )
            ? [context.hostId]
            : []
        })
      ),
    [runtimeStatusByEnvironmentId, taskSourceRepoContexts]
  )
  const unreachableTaskSourceHostKey = [...unreachableTaskSourceHostIds].sort().join('|')
  // The request a skipped host would have made was the dial that notices it came back; one status check stands in.
  const recheckUnreachableTaskSourceHosts = useCallback(() => {
    for (const hostId of unreachableTaskSourceHostIds) {
      const host = parseExecutionHostId(hostId)
      if (host?.kind === 'runtime') {
        void useAppStore.getState().refreshRuntimeEnvironmentStatus(host.environmentId)
      }
    }
  }, [unreachableTaskSourceHostIds])
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
        accountLabel: getJiraAccountLabel(selectedJiraSite)
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
  return Object.assign(model, {
    getTaskPickerRepoHostLabel,
    taskSourceHostAvailability,
    unreachableTaskSourceHostIds,
    unreachableTaskSourceHostKey,
    recheckUnreachableTaskSourceHosts,
    accountBackedTaskSourceHostId,
    fallbackTaskSourceProjectId,
    linearTaskSourceContext,
    jiraTaskSourceContext,
    jiraTaskSourceScopeKey,
    accountBackedTaskSourceHostAvailability
  })
}
export function useTaskPageSourceAvailability(model: TaskPageRuntimeHostsModel) {
  const preludeModel = useTaskPageSourceAvailabilityPrelude(model)
  return useTaskPageSourceSummary(preludeModel)
}
export type TaskPageSourceAvailabilityModel = ReturnType<typeof useTaskPageSourceAvailability>
