import { translate } from '@/i18n/i18n'
import { FolderSourceControlPanel } from '../folder/folder-source-control-panel'
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
      <FolderSourceControlPanel
        folderPath={worktreePath}
        folderWorktreeId={activeWorktree.id}
        connectionId={model.activeConnectionId}
        executionHostId={activeWorktree.hostId ?? 'local'}
        runtimeEnvironmentId={model.activeRepoRuntimeEnvironmentId}
        runtimeSettings={model.activeRepoSettings}
      />
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
