import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { TaskPageAzureDevOpsFilters } from './Filters'
import { AzureDevOpsBacklogTable } from './BacklogTable'
import { AzureDevOpsToolbar } from './Toolbar'

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-3 py-8 text-center text-xs text-muted-foreground">{children}</div>
}

export function TaskPageAzureDevOpsContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const { azureDevOpsViews: props } = model
  return (
    <div className="mt-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
      <AzureDevOpsToolbar {...props.toolbar} />
      {props.status === 'unauthenticated' ? (
        <Notice>
          {translate(
            'auto.components.TaskPage.azureDevOps.unauthenticated',
            'Azure DevOps is not authenticated. Run az login, or set ORCA_AZURE_DEVOPS_TOKEN, then refresh.'
          )}
        </Notice>
      ) : props.status === 'not-azure-remote' ? (
        <Notice>
          {translate(
            'auto.components.TaskPage.azureDevOps.notAzureRemote',
            'The selected repository does not have an Azure DevOps remote.'
          )}
        </Notice>
      ) : props.status === 'host-unreachable' ? (
        <Notice>
          {translate(
            'auto.components.TaskPage.azureDevOps.hostUnreachable',
            'Couldn’t reach the host that owns this repository, so its remote couldn’t be checked. Reconnect and refresh.'
          )}
        </Notice>
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
          <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
            {props.status === 'loading' && props.table.rows.length === 0 ? (
              <Notice>
                <LoaderCircle className="mx-auto size-4 animate-spin" />
              </Notice>
            ) : (
              <AzureDevOpsBacklogTable {...props.table} />
            )}
          </div>
        </>
      )}
    </div>
  )
}
