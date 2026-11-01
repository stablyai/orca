import type { TaskPageGitHubListStateModel } from '../github/use-task-page-github-list-state'
import { useCallback, useEffect, useMemo } from 'react'
import { getWorkItemRepo } from '@/lib/work-item-repo-row'
import type { GiteaWorkItem } from '../../../../../shared/gitea-types'
import { getTaskPageRepoSourceContext } from '../task-page-source-context'

type GiteaDetailInput = Pick<
  TaskPageGitHubListStateModel,
  | 'pageData'
  | 'openTaskPage'
  | 'repos'
  | 'selectedRepos'
  | 'primaryRepo'
  | 'giteaDialogItem'
  | 'setGiteaDialogItem'
>

export function useTaskPageGiteaDetail<Model extends GiteaDetailInput>(model: Model) {
  const {
    pageData,
    openTaskPage,
    repos,
    selectedRepos,
    primaryRepo,
    giteaDialogItem,
    setGiteaDialogItem
  } = model
  const giteaDialogRepo = useMemo(
    () =>
      giteaDialogItem ? (getWorkItemRepo(selectedRepos, giteaDialogItem) ?? primaryRepo) : null,
    [giteaDialogItem, primaryRepo, selectedRepos]
  )
  const giteaDialogSourceContext = useMemo(() => {
    if (!giteaDialogItem) {
      return null
    }
    if (
      pageData.openGiteaSourceContext?.provider === 'gitea' &&
      pageData.openGiteaWorkItem?.id === giteaDialogItem.id &&
      pageData.openGiteaWorkItem.repoId === giteaDialogItem.repoId &&
      pageData.openGiteaWorkItem.repoHostId === giteaDialogItem.repoHostId
    ) {
      return pageData.openGiteaSourceContext
    }
    return getTaskPageRepoSourceContext(giteaDialogRepo, 'gitea')
  }, [
    giteaDialogItem,
    giteaDialogRepo,
    pageData.openGiteaSourceContext,
    pageData.openGiteaWorkItem
  ])
  useEffect(() => {
    setGiteaDialogItem(pageData.openGiteaWorkItem ?? null)
  }, [pageData.openGiteaWorkItem, setGiteaDialogItem])
  const openGiteaDetailPage = useCallback(
    (item: GiteaWorkItem) => {
      openTaskPage(
        {
          taskSource: 'gitea',
          preselectedRepoId: item.repoId,
          openGiteaWorkItem: item,
          openGiteaSourceContext: getTaskPageRepoSourceContext(
            getWorkItemRepo(repos, item),
            'gitea'
          )
        },
        { recordTasksInteraction: false }
      )
    },
    [openTaskPage, repos]
  )
  return Object.assign(model, { giteaDialogRepo, giteaDialogSourceContext, openGiteaDetailPage })
}
