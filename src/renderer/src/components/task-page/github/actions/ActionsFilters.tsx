import { useState } from 'react'
import { RefreshCw, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ActionsChoice } from '@/components/right-sidebar/ActionsChoice'
import { actionsStatusLabel } from '@/components/right-sidebar/actions-status-label'
import type { ActionsRepositoryOption } from '@/components/right-sidebar/use-actions-repositories'
import type { useActionsRuns } from '@/components/right-sidebar/use-actions-runs'
import { ACTIONS_STATUSES } from '../../../../../../shared/github/actions-types'
import { actionsRepositoryUrl } from '../../../../../../shared/github/actions-web-url'
import { translate } from '@/i18n/i18n'

/** Apply run filters and retry only the failed workflow page, preserving run paging and loaded workflows. */
export function ActionsFilters({
  model,
  option
}: {
  model: ReturnType<typeof useActionsRuns>
  option: ActionsRepositoryOption
}) {
  const [branch, setBranch] = useState(model.query.branch ?? '')
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-md rounded-b-none border border-border/50 bg-muted/35 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ActionsChoice
          value={String(model.query.workflowId ?? '')}
          label={translate('actions.workflow', 'Workflow')}
          disabled={model.loading}
          options={[
            { value: '', label: translate('actions.allWorkflows', 'All workflows') },
            ...model.workflows.items.map((w) => ({ value: String(w.id), label: w.name }))
          ]}
          onChange={(value) =>
            model.setQuery({
              ...model.query,
              page: 1,
              workflowId: value ? Number(value) : undefined
            })
          }
        />
        <form
          className="flex min-w-0 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            model.setQuery({ ...model.query, page: 1, branch: branch.trim() || undefined })
          }}
        >
          <Input
            className="h-8 w-44"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            aria-label={translate('actions.branch', 'Branch')}
            placeholder={translate('actions.allBranches', 'All branches')}
          />
          <Button type="submit" variant="outline" size="sm" disabled={model.loading}>
            {translate('actions.apply', 'Apply')}
          </Button>
        </form>
        <Select
          value={model.query.status ?? 'all'}
          disabled={model.loading}
          onValueChange={(value) =>
            model.setQuery({ ...model.query, page: 1, status: value === 'all' ? undefined : value })
          }
        >
          <SelectTrigger className="h-8 w-40" aria-label={translate('actions.status', 'Status')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{translate('actions.allStatuses', 'All statuses')}</SelectItem>
            {ACTIONS_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {actionsStatusLabel(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(model.query.branch || model.query.workflowId || model.query.status) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={model.loading}
            onClick={() => {
              setBranch('')
              model.setQuery({ page: 1 })
            }}
          >
            {translate('actions.clear', 'Clear filters')}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={translate('actions.openActions', 'Open Actions on GitHub')}
            onClick={() => {
              void window.api.shell.openUrl(`${actionsRepositoryUrl(option.repository)}/actions`)
            }}
          >
            <ExternalLink className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={translate('actions.refresh', 'Refresh')}
            disabled={model.loading}
            onClick={model.refresh}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>
      {model.workflows.more && (
        <Button
          className="self-start"
          variant="link"
          size="xs"
          disabled={model.workflows.loading}
          onClick={model.moreWorkflows}
        >
          {translate('actions.moreWorkflows', 'Load more workflows')}
        </Button>
      )}
      {model.workflows.limit && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'actions.workflowsLimit',
            'Showing up to 1,000 workflows. Open Actions on GitHub for more.'
          )}
        </p>
      )}
      {model.workflows.error && (
        <div role="alert" className="text-xs text-destructive">
          {model.workflows.error}
          <Button
            variant="link"
            size="xs"
            disabled={model.workflows.loading}
            onClick={model.moreWorkflows}
          >
            {translate('actions.retryWorkflows', 'Retry workflows')}
          </Button>
        </div>
      )}
    </div>
  )
}
