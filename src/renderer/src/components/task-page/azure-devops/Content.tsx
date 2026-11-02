import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AzureDevOpsContentProps } from '@/components/use-task-page-azure-devops-state'
import { TaskPageAzureDevOpsFilters } from './Filters'
import { AzureDevOpsBacklogTable } from './BacklogTable'
import { AzureDevOpsBacklogNotices } from './BacklogNotices'
import { AzureDevOpsBoard } from './Board'
import { AzureDevOpsToolbar } from './Toolbar'

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-3 py-8 text-center text-xs text-muted-foreground">{children}</div>
}

function Spinner(): React.JSX.Element {
  return (
    <Notice>
      <LoaderCircle className="mx-auto size-4 animate-spin" />
    </Notice>
  )
}

/** The failures that are about the connection rather than the view; both views share them. */
function hostStatusNotice(
  status: AzureDevOpsContentProps['status'] | AzureDevOpsContentProps['boardErrorStatus']
): React.JSX.Element | null {
  if (status === 'unauthenticated') {
    return (
      <Notice>
        {translate(
          'auto.components.TaskPage.azureDevOps.unauthenticated',
          'Azure DevOps is not authenticated. Run az login, or set ORCA_AZURE_DEVOPS_TOKEN, then refresh.'
        )}
      </Notice>
    )
  }
  if (status === 'not-azure-remote') {
    return (
      <Notice>
        {translate(
          'auto.components.TaskPage.azureDevOps.notAzureRemote',
          'The selected repository does not have an Azure DevOps remote.'
        )}
      </Notice>
    )
  }
  if (status === 'host-unreachable') {
    return (
      <Notice>
        {translate(
          'auto.components.TaskPage.azureDevOps.hostUnreachable',
          'Couldn’t reach the host that owns this repository, so its remote couldn’t be checked. Reconnect and refresh.'
        )}
      </Notice>
    )
  }
  return null
}

/** The Work items area: its own failure notices, then the flat assigned-to-me list. */
export function AzureDevOpsWorkItemsArea(
  props: AzureDevOpsContentProps['workItems']
): React.JSX.Element {
  const hostNotice = hostStatusNotice(props.errorStatus)
  if (hostNotice !== null) {
    return hostNotice
  }
  if (props.errorMessage !== null) {
    return (
      <Notice>
        {translate(
          'auto.components.TaskPage.azureDevOps.workItems.loadFailed',
          'Couldn’t load your Azure DevOps work items: {{value0}}',
          { value0: props.errorMessage }
        )}
      </Notice>
    )
  }
  if (props.loading && props.table.rows.length === 0) {
    return <Spinner />
  }
  if (props.totalItemCount === 0) {
    return (
      <Notice>
        {translate(
          'auto.components.TaskPage.azureDevOps.workItems.empty',
          'No work items in this project are assigned to you.'
        )}
      </Notice>
    )
  }
  return (
    <>
      <AzureDevOpsBacklogNotices
        unhydratedItemCount={props.unhydratedItemCount}
        truncatedAtQueryLimit={props.truncatedAtQueryLimit}
      />
      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
        <AzureDevOpsBacklogTable {...props.table} />
      </div>
    </>
  )
}

/** The board area: its own failure notices, then the board itself. */
export function AzureDevOpsBoardArea(
  props: Pick<AzureDevOpsContentProps, 'board' | 'boardErrorStatus' | 'boardErrorMessage'>
): React.JSX.Element {
  const hostNotice = hostStatusNotice(props.boardErrorStatus)
  if (hostNotice !== null) {
    return hostNotice
  }
  if (props.boardErrorMessage !== null) {
    return (
      <Notice>
        {translate(
          'auto.components.TaskPage.azureDevOps.board.loadFailed',
          'Couldn’t load the Azure DevOps board: {{value0}}',
          { value0: props.boardErrorMessage }
        )}
      </Notice>
    )
  }
  return props.board === null ? <Spinner /> : <AzureDevOpsBoard {...props.board} />
}

export function TaskPageAzureDevOpsContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const { azureDevOpsViews: props } = model
  const hostNotice = hostStatusNotice(props.status)
  return (
    <div className="mt-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
      <AzureDevOpsToolbar {...props.toolbar} />
      {hostNotice !== null ? (
        hostNotice
      ) : props.view === 'workItems' ? (
        // Why: this view needs no team and no level, so a team/level failure must not hide it.
        <>
          <TaskPageAzureDevOpsFilters {...props.filters} />
          <AzureDevOpsWorkItemsArea {...props.workItems} />
        </>
      ) : props.status === 'error' ? (
        <Notice>
          {translate(
            'auto.components.TaskPage.azureDevOps.loadFailed',
            'Couldn’t load the Azure DevOps backlog: {{value0}}',
            { value0: props.errorMessage ?? '' }
          )}
        </Notice>
      ) : (
        <>
          <TaskPageAzureDevOpsFilters {...props.filters} />
          {props.view === 'board' ? (
            <AzureDevOpsBoardArea {...props} />
          ) : (
            <>
              <AzureDevOpsBacklogNotices unhydratedItemCount={props.backlogUnhydratedItemCount} />
              <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
                {props.status === 'loading' && props.table.rows.length === 0 ? (
                  <Spinner />
                ) : (
                  <AzureDevOpsBacklogTable {...props.table} />
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
