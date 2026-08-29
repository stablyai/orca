import React from 'react'

import GitLabItemDialog from '@/components/GitLabItemDialog'
import { JiraConnectDialog } from '@/components/jira-connect-dialog'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
import { translate } from '@/i18n/i18n'
import type { GitLabWorkItem } from '../../../../../shared/gitlab-types'
import type { LinearWorkspace } from '../../../../../shared/linear/workspace-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export type TaskPageConnectDialogsProps = {
  gitlabDialogItem: GitLabWorkItem | null
  gitlabDialogRepo: Repo | null
  gitlabDialogSourceContext: TaskSourceContext | null
  setGitlabDialogItem: (item: GitLabWorkItem | null) => void
  handleUseGitLabItem: (item: GitLabWorkItem) => void
  linearConnectOpen: boolean
  setLinearConnectOpen: (open: boolean) => void
  selectedLinearWorkspace: LinearWorkspace | null
  handleLinearAccessConnected: () => void
  jiraConnectOpen: boolean
  setJiraConnectOpen: (open: boolean) => void
}

export function TaskPageConnectDialogs({
  gitlabDialogItem,
  gitlabDialogRepo,
  gitlabDialogSourceContext,
  setGitlabDialogItem,
  handleUseGitLabItem,
  linearConnectOpen,
  setLinearConnectOpen,
  selectedLinearWorkspace,
  handleLinearAccessConnected,
  jiraConnectOpen,
  setJiraConnectOpen
}: TaskPageConnectDialogsProps): React.JSX.Element {
  return (
    <>
      <GitLabItemDialog
        item={gitlabDialogItem}
        // Why: repoPath comes from the clicked item's own repo, not primaryRepo — the GitLab fetch is now multi-repo.
        repoPath={gitlabDialogRepo?.path ?? null}
        repoId={gitlabDialogItem?.repoId ?? null}
        sourceContext={gitlabDialogSourceContext}
        onCreateWorkspace={(item) => {
          setGitlabDialogItem(null)
          handleUseGitLabItem(item)
        }}
        onClose={() => setGitlabDialogItem(null)}
      />

      <LinearApiKeyDialog
        open={linearConnectOpen}
        onOpenChange={setLinearConnectOpen}
        workspace={selectedLinearWorkspace}
        connectLabel={
          selectedLinearWorkspace
            ? translate(
                'auto.components.task.page.dialogs.task.page.connect.dialogs.353c7dc71d',
                'Update access'
              )
            : translate('auto.components.TaskPage.851017590d', 'Add Linear access')
        }
        onConnected={handleLinearAccessConnected}
      />

      <JiraConnectDialog open={jiraConnectOpen} onOpenChange={setJiraConnectOpen} />
    </>
  )
}
