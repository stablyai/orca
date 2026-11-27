import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import { getRepoWorkspaceCreationTargetHint } from '@/lib/workspace/creation/project-host-workspace-target'
import type { ItsaplanIssue } from '../../../../../shared/itsaplan/itsaplan-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { getItsaplanIssueWorkspaceSeed } from '../task-page-source-context'

export function buildItsaplanLinkedWorkItem(issue: ItsaplanIssue): LinkedWorkItemSummary {
  const description = issue.description.trim()
  return {
    type: 'issue',
    provider: 'itsaplan',
    number: issue.sequenceNumber,
    title: `${issue.identifier} ${issue.title}`,
    url: issue.url,
    ...(description
      ? { linkedContext: { provider: 'itsaplan', version: 1, renderedText: description } }
      : {})
  }
}

export function openItsaplanIssueComposer({
  issue,
  instanceId,
  sourceContext,
  repos
}: {
  issue: ItsaplanIssue
  instanceId: string | null
  sourceContext: TaskSourceContext | null
  repos: readonly Repo[]
}): void {
  if (!sourceContext || !instanceId) {
    toast.error(
      translate(
        'taskProviders.itsaplan.linkSourceUnavailable',
        "Couldn't link this It's a Plan issue. Reconnect It's a Plan, then try again."
      )
    )
    return
  }
  // Why: a subtask can live in another project than the list, so bind the issue's own ref.
  const taskSourceContext: TaskSourceContext = {
    ...sourceContext,
    providerIdentity: { provider: 'itsaplan', instanceId, projectRef: issue.projectRef }
  }
  const linkedWorkItem = buildItsaplanLinkedWorkItem(issue)
  const mappedRepo = repos.find(
    (repo) =>
      repo.defaultItsaplanProject?.instanceId === instanceId &&
      repo.defaultItsaplanProject.projectRef === issue.projectRef
  )
  const state = useAppStore.getState()
  state.openModal('new-workspace-composer', {
    linkedWorkItem,
    taskSourceContext,
    initialRepoId: mappedRepo?.id,
    initialWorkspaceTarget: mappedRepo
      ? getRepoWorkspaceCreationTargetHint(mappedRepo, state.projectHostSetups)
      : undefined,
    prefilledName: getItsaplanIssueWorkspaceSeed(issue),
    telemetrySource: 'sidebar'
  })
}
