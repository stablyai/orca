import { translate } from '@/i18n/i18n'
import { SourceControlPanelReady } from './panel-ready'
import { useSourceControlPanelModel } from './use-panel-model'

/** Resolves the panel model and guards the two states that have no source control to show. */
export function SourceControlPanel() {
  const model = useSourceControlPanelModel()
  const { activeRepo, activeWorktree, isFolder, worktreePath } = model

  if (!activeWorktree || !activeRepo || !worktreePath) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        {translate(
          'auto.components.right.sidebar.SourceControl.c07b236287',
          'Select a workspace to view changes'
        )}
      </div>
    )
  }
  if (isFolder) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        {translate(
          'auto.components.right.sidebar.SourceControl.e131cd7128',
          'Source Control is only available for Git repositories'
        )}
      </div>
    )
  }

  return (
    <SourceControlPanelReady
      activeRepo={activeRepo}
      activeWorktree={activeWorktree}
      currentWorktreeId={activeWorktree.id}
      model={model}
      worktreePath={worktreePath}
    />
  )
}
