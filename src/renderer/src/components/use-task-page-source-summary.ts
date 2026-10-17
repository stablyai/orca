import type { TaskPageSourceRepoScopeModel } from './use-task-page-source-repo-scope'
import { useMemo } from 'react'
import type { TaskProvider } from '../../../shared/task-providers'
import type {
  TaskSourceAvailabilityNotice,
  TaskSourceHostAvailability
} from './task-source-context-summary'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  getTaskSourceHostAvailabilityForHost,
  getTaskPageRepoSourceContext
} from './task-page-source-context'
import { getRepoBackedProviderAvailability } from '@/components/task-source-provider-availability'
import {
  getTaskSourceAvailabilityNotice,
  getTaskSourceContextSummary
} from './task-source-context-summary'
import { getRepoBackedTaskEmptyState } from '@/components/task-page-empty-state'
export function useTaskPageSourceSummary(model: TaskPageSourceRepoScopeModel) {
  const {
    preflightStatus,
    preflightStatusChecked,
    preflightStatusCurrent,
    preflightDescribesDesktop,
    selectedRepos,
    githubTaskRepos,
    gitlabTaskRepos,
    selectedLinearWorkspace,
    selectedJiraSite,
    sourceOptions,
    taskSource,
    runtimePreflightStatusByHostId,
    taskSourceRepoContexts,
    hostRegistryById,
    hostLabelById,
    taskSourceHostAvailability,
    accountBackedTaskSourceHostId,
    accountBackedTaskSourceHostAvailability
  } = model
  const taskSourceAvailabilityNoticeByProvider = useMemo<
    Partial<Record<TaskProvider, TaskSourceAvailabilityNotice>>
  >(() => {
    const availabilityForContexts = (
      provider: Extract<TaskProvider, 'github' | 'gitlab'>,
      contexts: readonly TaskSourceContext[]
    ): TaskSourceHostAvailability[] => [
      ...contexts.flatMap((context) => {
        const host = hostRegistryById.get(context.hostId)
        const availability = getTaskSourceHostAvailabilityForHost(host, context.hostId)
        return availability ? [availability] : []
      }),
      ...getRepoBackedProviderAvailability({
        provider,
        contexts,
        preflightStatus,
        preflightReady:
          preflightStatusCurrent && preflightStatusChecked && preflightDescribesDesktop,
        runtimePreflightStatusByHostId
      })
    ]
    const accountHost = hostRegistryById.get(accountBackedTaskSourceHostId)
    const accountHostAvailability = getTaskSourceHostAvailabilityForHost(
      accountHost,
      accountBackedTaskSourceHostId
    )
    const accountAvailability = accountHostAvailability ? [accountHostAvailability] : []
    const labelFor = (provider: TaskProvider): string =>
      sourceOptions.find((source) => source.id === provider)?.label ?? provider
    // Why: a repo skipped as hosted on the other forge is never queried, so its host cannot block this source.
    return {
      github:
        getTaskSourceAvailabilityNotice({
          providerLabel: labelFor('github'),
          sourceCount: githubTaskRepos.length,
          hostLabelById,
          hostAvailability: availabilityForContexts(
            'github',
            githubTaskRepos
              .map((repo) => getTaskPageRepoSourceContext(repo, 'github'))
              .filter((context): context is TaskSourceContext => context !== null)
          )
        }) ?? undefined,
      gitlab:
        getTaskSourceAvailabilityNotice({
          providerLabel: labelFor('gitlab'),
          sourceCount: gitlabTaskRepos.length,
          hostLabelById,
          hostAvailability: availabilityForContexts(
            'gitlab',
            gitlabTaskRepos
              .map((repo) => getTaskPageRepoSourceContext(repo, 'gitlab'))
              .filter((context): context is TaskSourceContext => context !== null)
          )
        }) ?? undefined,
      linear:
        getTaskSourceAvailabilityNotice({
          providerLabel: labelFor('linear'),
          sourceCount: 1,
          hostLabelById,
          hostAvailability: accountAvailability
        }) ?? undefined,
      jira:
        getTaskSourceAvailabilityNotice({
          providerLabel: labelFor('jira'),
          sourceCount: 1,
          hostLabelById,
          hostAvailability: accountAvailability
        }) ?? undefined
    }
  }, [
    accountBackedTaskSourceHostId,
    hostRegistryById,
    hostLabelById,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusCurrent,
    preflightDescribesDesktop,
    runtimePreflightStatusByHostId,
    githubTaskRepos,
    gitlabTaskRepos,
    sourceOptions
  ])
  const taskSourceContextSummary = useMemo(() => {
    const providerLabel =
      sourceOptions.find((source) => source.id === taskSource)?.label ?? taskSource
    return getTaskSourceContextSummary({
      provider: taskSource,
      providerLabel,
      repoContexts: taskSourceRepoContexts,
      hostAvailability:
        taskSource === 'linear' || taskSource === 'jira'
          ? accountBackedTaskSourceHostAvailability
          : taskSourceHostAvailability,
      accountHostId: accountBackedTaskSourceHostId,
      hostLabelById,
      selectedRepoCount: selectedRepos.length,
      linearWorkspaceName:
        selectedLinearWorkspace?.organizationName ?? selectedLinearWorkspace?.id ?? null,
      jiraSiteName: selectedJiraSite?.displayName ?? selectedJiraSite?.siteUrl ?? null
    })
  }, [
    selectedJiraSite,
    selectedLinearWorkspace,
    selectedRepos.length,
    sourceOptions,
    taskSource,
    accountBackedTaskSourceHostAvailability,
    accountBackedTaskSourceHostId,
    hostLabelById,
    taskSourceHostAvailability,
    taskSourceRepoContexts
  ])
  const taskSourceAvailabilityNotice = useMemo(() => {
    // Why: the banner must describe the same repos as the source button beside it.
    if (taskSource === 'github' || taskSource === 'gitlab') {
      return taskSourceAvailabilityNoticeByProvider[taskSource] ?? null
    }
    const providerLabel =
      sourceOptions.find((source) => source.id === taskSource)?.label ?? taskSource
    return getTaskSourceAvailabilityNotice({
      providerLabel,
      sourceCount: 1,
      hostAvailability: accountBackedTaskSourceHostAvailability,
      hostLabelById
    })
  }, [
    accountBackedTaskSourceHostAvailability,
    hostLabelById,
    sourceOptions,
    taskSource,
    taskSourceAvailabilityNoticeByProvider
  ])
  const githubEmptyState = useMemo(
    () =>
      getRepoBackedTaskEmptyState({
        provider: 'github',
        selectedRepoCount: selectedRepos.length,
        sourceRepoCount: githubTaskRepos.length
      }),
    [githubTaskRepos.length, selectedRepos.length]
  )
  const nextModel = model as typeof model & {
    taskSourceAvailabilityNoticeByProvider: typeof taskSourceAvailabilityNoticeByProvider
    taskSourceContextSummary: typeof taskSourceContextSummary
    taskSourceAvailabilityNotice: typeof taskSourceAvailabilityNotice
    githubEmptyState: typeof githubEmptyState
  }
  nextModel.taskSourceAvailabilityNoticeByProvider = taskSourceAvailabilityNoticeByProvider
  nextModel.taskSourceContextSummary = taskSourceContextSummary
  nextModel.taskSourceAvailabilityNotice = taskSourceAvailabilityNotice
  nextModel.githubEmptyState = githubEmptyState
  return nextModel
}
export type TaskPageSourceSummaryModel = ReturnType<typeof useTaskPageSourceSummary>
