import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { SourceControlPanelReady } from './panel-ready'
import { useSourceControlPanelModel } from './use-panel-model'
import { LineageSourceControlSections } from '../lineage/LineageSourceControlSections'
import { useLineageTowerRouting } from '../../lineage-members/use-lineage-tower-routing'
import { AddToTowerEntryContext } from '../../lineage-members/add-to-tower-entry'

/** Routes a tower with members to one original panel per member; everything else gets the single panel. */
export function SourceControlPanel() {
  const { showLineage, members, towerKey, supported, refresh } = useLineageTowerRouting()
  const entry = useMemo(
    () =>
      supported && towerKey
        ? { parentWorkspaceKey: towerKey, onChanged: () => void refresh() }
        : null,
    [supported, towerKey, refresh]
  )

  // why: until members load (or on hosts without lineage) the standard panel renders, so there is no flash
  if (showLineage) {
    return (
      <LineageSourceControlSections
        members={members}
        PanelComponent={SingleSourceControlPanel}
        parentWorkspaceKey={towerKey ?? undefined}
        onMembersChanged={() => void refresh()}
      />
    )
  }
  return (
    <AddToTowerEntryContext.Provider value={entry}>
      <SingleSourceControlPanel />
    </AddToTowerEntryContext.Provider>
  )
}

/** Resolves the panel model and guards the two states that have no source control to show. */
export function SingleSourceControlPanel() {
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
