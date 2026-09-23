import { useCallback, useMemo, useState } from 'react'
import type { GiteaWorkItem } from '../../../../../shared/gitea-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { GiteaIssueScope } from '@/store/slices/gitea'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { GiteaTaskList } from '@/components/GiteaTaskList'
import { GiteaIssueWorkspace, type GiteaWorkspaceSelection } from '@/components/GiteaIssueWorkspace'
import { GiteaPullRequestWorkspace } from '@/components/GiteaPullRequestWorkspace'
import { TaskPageJiraContent } from '../jira/Content'

export function TaskPageGiteaContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const { taskSource, selectedRepos, openModal } = model
  const [selection, setSelection] = useState<GiteaWorkspaceSelection | null>(null)

  const makeScope = useCallback(
    (repo: Repo): GiteaIssueScope => ({ repoPath: repo.path, repoId: repo.id }),
    []
  )
  const openDetail = useCallback(
    (repo: Repo, item: GiteaWorkItem) => setSelection({ repo, item, scope: makeScope(repo) }),
    [makeScope]
  )
  const closeDetail = useCallback(() => setSelection(null), [])
  const useItem = useCallback(
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
      openModal('new-workspace-composer', { linkedWorkItem, telemetrySource: 'sidebar' })
    },
    [openModal]
  )
  const repos = useMemo(() => [...selectedRepos], [selectedRepos])

  if (taskSource !== 'gitea') {
    return <TaskPageJiraContent model={model} />
  }
  if (selection) {
    return selection.item.type === 'pull' ? (
      <GiteaPullRequestWorkspace selection={selection} onUse={useItem} onClose={closeDetail} />
    ) : (
      <GiteaIssueWorkspace selection={selection} onUse={useItem} onClose={closeDetail} />
    )
  }
  return <GiteaTaskList repos={repos} makeScope={makeScope} onOpen={openDetail} />
}
