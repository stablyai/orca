import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { buildJiraPresetJql } from '../../../shared/jira/jira-preset-jql'
import {
  getJiraStatusCatalogScopeKey,
  includeSelectedJiraStatuses
} from './task-page-jira-status-catalog'
import { restrictJiraQueryToProject } from '../../../shared/jira-project-reference'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'

export function TaskPageJiraStatusFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    jiraHasWorkspace,
    selectedJiraStatuses,
    selectJiraStatuses,
    jiraQuickFiltersReady,
    jiraQuickFiltersPending,
    jiraQuickFiltersLoading,
    jiraQuickFiltersError,
    retryJiraQuickFilters,
    jiraStatusCatalog,
    jiraTaskSourceScopeKey,
    selectedJiraSiteId,
    activeJiraPreset,
    jiraCurrentSprint,
    jiraSearchInput,
    setJiraSearchInput,
    setAppliedJiraSearch,
    clearJiraSavedFilterSelection,
    jiraSavedFiltersPending
  } = model
  if (jiraHasWorkspace) {
    return null
  }
  const scopeKey = getJiraStatusCatalogScopeKey(
    jiraTaskSourceScopeKey,
    selectedJiraSiteId,
    activeJiraPreset,
    model.jiraProjectFilter
  )
  const statuses = includeSelectedJiraStatuses(
    jiraStatusCatalog?.scopeKey === scopeKey ? jiraStatusCatalog.items : [],
    selectedJiraStatuses
  )
  const presetJql = buildJiraPresetJql(activeJiraPreset, {
    statuses: selectedJiraStatuses,
    currentSprint: jiraCurrentSprint
  })
  const preview = model.jiraProjectFilter
    ? restrictJiraQueryToProject(presetJql, model.jiraProjectFilter)
    : presetJql
  const disabled =
    !jiraQuickFiltersReady ||
    jiraQuickFiltersLoading ||
    jiraQuickFiltersPending ||
    jiraSavedFiltersPending
  if (jiraSearchInput.trim() || model.jiraFavouriteFilter) {
    return selectedJiraStatuses.length ? (
      <p className="mt-2 text-xs text-muted-foreground">
        {translate(
          'jira.statusFilters.manualQuery',
          'Status filters apply to preset views. Clear the search to use them.'
        )}
      </p>
    ) : null
  }
  return (
    <div className="mt-3 space-y-2">
      {jiraQuickFiltersError ? (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          <span>{jiraQuickFiltersError}</span>
          <Button
            variant="ghost"
            size="xs"
            disabled={jiraQuickFiltersLoading || jiraQuickFiltersPending}
            onClick={retryJiraQuickFilters}
          >
            {translate('jira.savedFilters.retry', 'Retry')}
          </Button>
        </div>
      ) : null}
      {statuses.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="multiple"
            variant="segmented"
            size="xs"
            spacing={1}
            value={selectedJiraStatuses}
            disabled={disabled}
            aria-label={translate('jira.statusFilters.label', 'Filter Jira issues by status')}
            onValueChange={(next) => {
              void selectJiraStatuses(next).catch(() => {})
            }}
            className="flex-wrap"
          >
            {statuses.map((status) => (
              <ToggleGroupItem key={status.name} value={status.name}>
                {status.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {selectedJiraStatuses.length ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => {
                void selectJiraStatuses([]).catch(() => {})
              }}
            >
              {translate('jira.statusFilters.clear', 'Clear statuses')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {selectedJiraStatuses.length ? (
        <>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={preview}
              aria-label={translate('jira.statusFilters.jql', 'Status filter JQL')}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => {
                void clearJiraSavedFilterSelection()
                  .then(() => {
                    setJiraSearchInput(preview)
                    setAppliedJiraSearch(preview)
                  })
                  .catch(() => {})
              }}
            >
              {translate('jira.statusFilters.editJql', 'Edit as JQL')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'jira.statusFilters.catalogHint',
              'Statuses come from loaded issues. Clear statuses to discover others in this view.'
            )}
          </p>
        </>
      ) : null}
    </div>
  )
}
