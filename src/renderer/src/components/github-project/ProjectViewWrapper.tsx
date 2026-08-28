import React from 'react'
import GitHubItemDialog from '@/components/GitHubItemDialog'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import ProjectViewList from './ProjectViewList'
import ProjectItemSlugDialog from './ProjectItemSlugDialog'
import { ProjectMissingRepoDialog } from './ProjectMissingRepoDialog'
import { ProjectViewToolbar } from './ProjectViewToolbar'
import {
  ProjectTableSkeleton,
  ProjectViewErrorState,
  ProjectViewTabStrip
} from './ProjectViewStates'
import { useProjectRowActions } from './useProjectRowActions'
import { useProjectViewTable } from './useProjectViewTable'

type Props = { selectedRepoIds: ReadonlySet<string> }

export default function ProjectViewWrapper({ selectedRepoIds }: Props): React.JSX.Element {
  const tableState = useProjectViewTable(selectedRepoIds)
  const rowActions = useProjectRowActions({
    table: tableState.table,
    currentCacheKey: tableState.currentCacheKey,
    selectedRepoIds
  })
  const addRepo = useAppStore((state) => state.addRepo)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ProjectViewToolbar tableState={tableState} />
      {tableState.activeProject ? (
        <ProjectViewTabStrip
          views={tableState.views}
          activeViewId={tableState.viewId ?? null}
          onPick={(viewId) => void tableState.switchView(viewId)}
        />
      ) : null}
      <ProjectViewBody tableState={tableState} rowActions={rowActions} />
      <ProjectItemSlugDialog
        projectOrigin={rowActions.missingDialogs.slugDialog?.origin ?? null}
        sourceSettings={tableState.settings}
        onClose={() => rowActions.setSlugDialog(null)}
      />
      <ProjectMissingRepoDialog
        missingRepo={rowActions.missingDialogs.repoNotInOrca}
        onClose={() => rowActions.setRepoNotInOrca(null)}
        onAddRepo={addRepo}
      />
    </div>
  )
}

function ProjectViewBody({
  tableState,
  rowActions
}: {
  tableState: ReturnType<typeof useProjectViewTable>
  rowActions: ReturnType<typeof useProjectRowActions>
}): React.JSX.Element | null {
  const { activeProject, error, loading, table, visibleTable } = tableState
  if (!activeProject) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {translate(
          'auto.components.github.project.ProjectViewWrapper.512fc171d6',
          'Choose a project to get started.'
        )}
      </div>
    )
  }
  if (loading && !table) {
    return <ProjectTableSkeleton />
  }
  if (error) {
    return (
      <ProjectViewErrorState
        error={error.error}
        totalCount={error.totalCount}
        host={activeProject.host}
        onOpenInGitHub={() => {
          if (table) {
            void window.api.shell.openUrl(
              `${table.project.url}/views/${table.selectedView.number ?? ''}`
            )
          }
        }}
      />
    )
  }
  if (visibleTable && rowActions.resolvedDialogRepoItem) {
    const dialogItem = rowActions.resolvedDialogRepoItem
    return (
      <GitHubItemDialog
        workItem={dialogItem.workItem}
        repoPath={dialogItem.repoPath}
        repoId={dialogItem.repoId}
        sourceContext={rowActions.dialogSourceContext}
        projectOrigin={dialogItem.origin}
        backLabel={translate(
          'auto.components.github.project.ProjectViewWrapper.1aa7c952b9',
          'Project view'
        )}
        onUse={(item) => {
          rowActions.setDialogRepoItem(null)
          // Why: issue #4756 keeps project-view actions on the direct "start work now" path, not the TaskPage background-create flow.
          void launchWorkItemDirect({
            item,
            repoId: dialogItem.workItem.repoId,
            launchSource: 'task_page',
            telemetrySource: 'sidebar',
            openModalFallback: () => {
              if (item.url) {
                void window.api.shell.openUrl(item.url)
              }
            }
          })
        }}
        onClose={() => rowActions.setDialogRepoItem(null)}
      />
    )
  }
  if (!visibleTable) {
    return null
  }
  return (
    <ProjectViewList
      table={visibleTable}
      onOpenDialog={rowActions.openDialog}
      onEditField={(row, fieldId, value) => void rowActions.editField(row, fieldId, value)}
      onEditAssignees={(row, add, remove) => void rowActions.editAssignees(row, add, remove)}
      onEditLabels={(row, add, remove) => void rowActions.editLabels(row, add, remove)}
      onEditIssueType={(row, issueType) => void rowActions.editIssueType(row, issueType)}
      onOpenInBrowser={(row) => {
        if (row.content.url) {
          void window.api.shell.openUrl(row.content.url)
        }
      }}
      onStartWork={rowActions.startWork}
      sourceSettings={tableState.settings}
    />
  )
}
