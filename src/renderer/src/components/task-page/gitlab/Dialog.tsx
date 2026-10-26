import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import GitLabItemDialog from '@/components/GitLabItemDialog'
export function TaskPageGitLabDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    gitlabDialogItem,
    setGitlabDialogItem,
    gitlabDialogRepo,
    gitlabDialogSourceContext,
    handleUseGitLabItem
  } = model
  return (
    <GitLabItemDialog
      item={gitlabDialogItem}
      // Use the clicked item’s repo because GitLab results can span multiple repos.
      repoPath={gitlabDialogRepo?.path ?? null}
      repoId={gitlabDialogItem?.repoId ?? null}
      sourceContext={gitlabDialogSourceContext}
      onCreateWorkspace={(item) => {
        setGitlabDialogItem(null)
        handleUseGitLabItem(item)
      }}
      onClose={() => setGitlabDialogItem(null)}
    />
  )
}
