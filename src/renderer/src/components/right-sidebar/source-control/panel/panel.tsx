import { translate } from '@/i18n/i18n'
import { PerforcePanel } from '../../perforce/perforce-panel'
import { usePerforceWorkspace } from '../../perforce/use-perforce-workspace'
import { usePerforceWorkspaceTarget } from '@/lib/perforce-workspace-target'
import { perforceWorkspaceKey } from '../../../../runtime/runtime-perforce-client'
import { SourceControlPanelReady } from './panel-ready'
import { useSourceControlPanelModel } from './use-panel-model'

/** Resolves the panel model and guards the two states that have no source control to show. */
export function SourceControlPanel() {
  const model = useSourceControlPanelModel()
  const { activeRepo, activeWorktree, activeConnectionId, isFolder, worktreePath } = model
  const perforceTarget = usePerforceWorkspaceTarget(
    activeWorktree?.id,
    worktreePath,
    activeConnectionId
  )
  const { isPerforce } = usePerforceWorkspace(perforceTarget, isFolder)

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
  if (isPerforce && perforceTarget) {
    return (
      // Why key: the sidebar keeps panels alive across workspaces, and one workspace's files must
      // never sit under another's actions while the new status loads.
      <PerforcePanel
        key={perforceWorkspaceKey(perforceTarget)}
        worktreeId={activeWorktree.id}
        target={perforceTarget}
      />
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
