import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import GiteaItemDialog from '@/components/GiteaItemDialog'
export function TaskPageGiteaDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    giteaDialogItem,
    setGiteaDialogItem,
    giteaDialogRepo,
    giteaDialogSourceContext,
    handleUseGiteaItem
  } = model
  return (
    <GiteaItemDialog
      item={giteaDialogItem}
      // Use the clicked item’s repo because Gitea results can span multiple repos.
      repoPath={giteaDialogRepo?.path ?? null}
      repoId={giteaDialogItem?.repoId ?? null}
      sourceContext={giteaDialogSourceContext}
      onCreateWorkspace={(item) => {
        setGiteaDialogItem(null)
        handleUseGiteaItem(item)
      }}
      onClose={() => setGiteaDialogItem(null)}
    />
  )
}
