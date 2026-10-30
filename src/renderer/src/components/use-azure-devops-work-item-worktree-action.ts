import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type {
  AzureDevOpsTeam,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemDetail,
  AzureDevOpsTeamConfiguration
} from '../../../shared/azure-devops/boards-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskPageRuntimeHostsModel } from './task-page/use-task-page-runtime-hosts'
import {
  getAzureDevOpsWorkItemWorkspaceSeed,
  getTaskPageRepoSourceContext
} from './task-page/task-page-source-context'

/** "Use this work item": opens the new-workspace composer seeded from the item. */
export function useAzureDevOpsWorkItemWorktreeAction(args: {
  repo: Repo | null
  itemById: ReadonlyMap<number, AzureDevOpsWorkItem>
  detail: AzureDevOpsWorkItemDetail | null
  configuration: AzureDevOpsTeamConfiguration | null
  team: AzureDevOpsTeam | null
  teamName: string | null
  openModal: TaskPageRuntimeHostsModel['openModal']
  setDetailId: (id: number | null) => void
}): (id: number) => void {
  const { repo, itemById, detail, configuration, team, teamName, openModal, setDetailId } = args
  return useCallback(
    (id: number) => {
      const item: AzureDevOpsWorkItem | undefined =
        itemById.get(id) ?? (detail?.id === id ? detail : undefined)
      if (!item || !configuration || !teamName) {
        return
      }
      // Why: the linked chip prepends `#number` itself; the title must stay the bare title.
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        provider: 'azure-devops',
        number: item.id,
        title: item.title,
        url: item.url,
        azureDevOpsIdentifier: String(item.id)
      }
      const taskSourceContext = getTaskPageRepoSourceContext(repo, 'azure-devops', null, {
        provider: 'azure-devops',
        organization: configuration.repo.organization,
        project: configuration.repo.project,
        teamId: team?.id ?? null,
        teamName
      })
      if (!taskSourceContext) {
        toast.error(
          translate(
            'auto.components.TaskPage.azureDevOps.linkUnavailable',
            'Couldn’t link this work item. Reload the backlog and try again.'
          )
        )
        return
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext,
        prefilledName: getAzureDevOpsWorkItemWorkspaceSeed(item),
        telemetrySource: 'sidebar'
      })
      setDetailId(null)
    },
    [itemById, detail, configuration, teamName, team, repo, openModal, setDetailId]
  )
}
