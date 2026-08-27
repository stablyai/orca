import React from 'react'

import GitHubItemDialog, { type ItemDialogTab } from '@/components/GitHubItemDialog'
import PullRequestPage from '@/components/PullRequestPage'
import { translate } from '@/i18n/i18n'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export type GithubDetailHostProps = {
  dialogWorkItem: GitHubWorkItem
  dialogInitialTab: ItemDialogTab | undefined
  dialogRepoPath: string | null
  dialogSourceContext: TaskSourceContext | null
  setDialogWorkItem: (item: GitHubWorkItem | null) => void
  handleUseWorkItem: (item: GitHubWorkItem) => void
  handleDialogReviewRequestsChange: (
    itemKey: { id: string; repoId: string },
    reviewRequests: GitHubAssignableUser[]
  ) => void
  closeTaskDetailPage: () => void
}

export function GithubDetailHost({
  dialogWorkItem,
  dialogInitialTab,
  dialogRepoPath,
  dialogSourceContext,
  setDialogWorkItem,
  handleUseWorkItem,
  handleDialogReviewRequestsChange,
  closeTaskDetailPage
}: GithubDetailHostProps): React.JSX.Element {
  return dialogWorkItem.type === 'pr' ? (
    <PullRequestPage
      workItem={dialogWorkItem}
      initialTab={dialogInitialTab}
      repoPath={dialogRepoPath}
      repoId={dialogWorkItem.repoId}
      sourceContext={dialogSourceContext}
      backLabel={translate(
        'auto.components.task.page.github.github.detail.host.8d5cde4770',
        'Pull requests'
      )}
      onUse={(item) => {
        setDialogWorkItem(null)
        handleUseWorkItem(item)
      }}
      onReviewRequestsChange={handleDialogReviewRequestsChange}
      onClose={closeTaskDetailPage}
    />
  ) : (
    <GitHubItemDialog
      workItem={dialogWorkItem}
      initialTab={dialogInitialTab}
      repoPath={dialogRepoPath}
      repoId={dialogWorkItem.repoId}
      sourceContext={dialogSourceContext}
      backLabel={translate(
        'auto.components.task.page.github.github.detail.host.312ca15778',
        'GitHub list'
      )}
      onUse={(item) => {
        setDialogWorkItem(null)
        handleUseWorkItem(item)
      }}
      onReviewRequestsChange={handleDialogReviewRequestsChange}
      onClose={closeTaskDetailPage}
    />
  )
}
