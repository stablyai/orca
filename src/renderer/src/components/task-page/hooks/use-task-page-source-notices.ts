import { useMemo } from 'react'

import type { ExecutionHostRegistryEntry } from '../../../../../shared/execution-host-registry'
import type { JiraSite } from '../../../../../shared/jira-types'
import type { LinearWorkspace } from '../../../../../shared/linear/workspace-types'
import type { PreflightStatus } from '../../../../../preload/api-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { getRepoBackedTaskEmptyState } from '@/components/task-page-empty-state'
import type { SourceOption } from '@/components/task-page-localized-options'
import {
  getTaskSourceAvailabilityNotice,
  getTaskSourceContextSummary,
  type TaskSourceAvailabilityNotice,
  type TaskSourceHostAvailability
} from '@/components/task-source-context-summary'
import {
  getRepoBackedProviderAvailability,
  type RuntimeProviderPreflightStatus
} from '@/components/task-source-provider-availability'
import { getTaskPageRepoSourceContext } from '../source/repo-source-context'
import { getTaskSourceHostAvailabilityForHost } from '../source/task-source-host-availability'

export function useTaskPageSourceNotices({
  taskSource,
  selectedRepos,
  hostRegistryById,
  hostLabelById,
  preflightStatus,
  preflightStatusCurrent,
  preflightStatusChecked,
  runtimePreflightStatusByHostId,
  taskSourceRepoContexts,
  accountBackedTaskSourceHostId,
  accountBackedTaskSourceHostAvailability,
  taskSourceHostAvailability,
  selectedLinearWorkspace,
  selectedJiraSite,
  sourceOptions
}: {
  taskSource: TaskProvider
  selectedRepos: Repo[]
  hostRegistryById: ReadonlyMap<TaskSourceContext['hostId'], ExecutionHostRegistryEntry>
  hostLabelById: ReadonlyMap<TaskSourceContext['hostId'], string>
  preflightStatus: PreflightStatus | null
  preflightStatusCurrent: boolean
  preflightStatusChecked: boolean
  runtimePreflightStatusByHostId: ReadonlyMap<
    TaskSourceContext['hostId'],
    RuntimeProviderPreflightStatus
  >
  taskSourceRepoContexts: TaskSourceContext[]
  accountBackedTaskSourceHostId: TaskSourceContext['hostId']
  accountBackedTaskSourceHostAvailability: TaskSourceHostAvailability[]
  taskSourceHostAvailability: TaskSourceHostAvailability[]
  selectedLinearWorkspace: LinearWorkspace | null
  selectedJiraSite: JiraSite | null
  sourceOptions: SourceOption[]
}) {
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
        preflightReady: preflightStatusCurrent && preflightStatusChecked,
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
    return {
      github:
        getTaskSourceAvailabilityNotice({
          providerLabel: labelFor('github'),
          sourceCount: selectedRepos.length,
          hostLabelById,
          hostAvailability: availabilityForContexts(
            'github',
            selectedRepos
              .map((repo) => getTaskPageRepoSourceContext(repo, 'github'))
              .filter((context): context is TaskSourceContext => context !== null)
          )
        }) ?? undefined,
      gitlab:
        getTaskSourceAvailabilityNotice({
          providerLabel: labelFor('gitlab'),
          sourceCount: selectedRepos.length,
          hostLabelById,
          hostAvailability: availabilityForContexts(
            'gitlab',
            selectedRepos
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
    runtimePreflightStatusByHostId,
    selectedRepos,
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
    const providerLabel =
      sourceOptions.find((source) => source.id === taskSource)?.label ?? taskSource
    return getTaskSourceAvailabilityNotice({
      providerLabel,
      sourceCount:
        taskSource === 'linear' || taskSource === 'jira'
          ? 1
          : Math.max(1, taskSourceRepoContexts.length),
      hostAvailability:
        taskSource === 'linear' || taskSource === 'jira'
          ? accountBackedTaskSourceHostAvailability
          : taskSourceHostAvailability,
      hostLabelById
    })
  }, [
    accountBackedTaskSourceHostAvailability,
    hostLabelById,
    sourceOptions,
    taskSource,
    taskSourceHostAvailability,
    taskSourceRepoContexts.length
  ])
  const githubEmptyState = useMemo(
    () =>
      getRepoBackedTaskEmptyState({
        provider: 'github',
        selectedRepoCount: selectedRepos.length
      }),
    [selectedRepos.length]
  )

  return {
    taskSourceAvailabilityNoticeByProvider,
    taskSourceContextSummary,
    taskSourceAvailabilityNotice,
    githubEmptyState
  }
}
