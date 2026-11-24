import { useCallback } from 'react'
import type { GiteaWorkItem } from '../../../../../shared/gitea/gitea-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { getTaskPageRepoSourceContext } from '../../../lib/work-items/task-repo-source-context'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { GiteaIssueWorkspace } from '@/components/gitea-item-dialog/GiteaIssueWorkspace'
import { GiteaPullRequestWorkspace } from '@/components/gitea-item-dialog/GiteaPullRequestWorkspace'
import { getGiteaWorkItemWorkspaceSeed } from '../task-page-source-context'
import { TaskPageJiraContent } from '../jira/Content'
import { TaskPageGiteaItemList } from './ItemList'
import { giteaTaskRepoScope, type GiteaTaskRow } from './use-task-page-gitea-list'

export function TaskPageGiteaContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    taskSource,
    selectedRepos,
    openModal,
    giteaSelection: selection,
    setGiteaSelection: setSelection
  } = model

  const repoForRow = useCallback(
    (item: GiteaTaskRow): Repo | undefined => selectedRepos.find((repo) => repo.id === item.repoId),
    [selectedRepos]
  )
  const openDetail = useCallback(
    (item: GiteaTaskRow) => {
      const repo = repoForRow(item)
      if (repo) {
        setSelection({ repo, item, scope: giteaTaskRepoScope(repo) })
      }
    },
    [repoForRow, setSelection]
  )
  const closeDetail = useCallback(() => setSelection(null), [setSelection])
  const startWorkspace = useCallback(
    (repo: Repo, item: GiteaWorkItem) => {
      setSelection(null)
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: item.type === 'pull' ? 'pr' : 'issue',
        provider: 'gitea',
        number: item.number,
        title: item.title,
        url: item.url,
        repoId: repo.id
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext: getTaskPageRepoSourceContext(repo, 'gitea', item),
        prefilledName: getGiteaWorkItemWorkspaceSeed(item),
        initialRepoId: repo.id,
        telemetrySource: 'sidebar'
      })
    },
    [openModal, setSelection]
  )
  const startWorkspaceForRow = useCallback(
    (item: GiteaTaskRow) => {
      const repo = repoForRow(item)
      if (repo) {
        startWorkspace(repo, item)
      }
    },
    [repoForRow, startWorkspace]
  )

  if (taskSource !== 'gitea') {
    return <TaskPageJiraContent model={model} />
  }
  if (selection) {
    return selection.item.type === 'pull' ? (
      <GiteaPullRequestWorkspace
        selection={selection}
        onUse={startWorkspace}
        onClose={closeDetail}
      />
    ) : (
      <GiteaIssueWorkspace selection={selection} onUse={startWorkspace} onClose={closeDetail} />
    )
  }
  return <TaskPageGiteaItemList model={model} onOpen={openDetail} onUse={startWorkspaceForRow} />
}
