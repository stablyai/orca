import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslate } from '@/i18n/use-translate'
import { buildJiraPresetJql } from '../../../../../../shared/jira/jira-preset-jql'
import {
  getJiraStatusCatalogScopeKey,
  includeSelectedJiraStatuses
} from './task-page-jira-status-catalog'
import { restrictJiraQueryToProject } from '../../../../../../shared/jira/jira-project-reference'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'

export function TaskPageJiraStatusFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const {
    jiraHasWorkspace,
    selectedJiraStatuses,
    selectJiraStatuses,
    jiraQuickFiltersReady,
    jiraQuickFiltersPending,
    jiraQuickFiltersLoading,
    jiraStatusCatalog,
    jiraTaskSourceScopeKey,
    selectedJiraSiteId,
    activeJiraPreset,
    jiraCurrentSprint,
    jiraFavouriteFilter,
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
  if (jiraFavouriteFilter || jiraSearchInput.trim()) {
    return (
      <p className="text-xs text-muted-foreground">
        {jiraFavouriteFilter
          ? t(
              'jira.statusFilters.favouriteActive',
              'Clear the Jira favourite or choose a preset view to use status filters.'
            )
          : t(
              'jira.statusFilters.manualQuery',
              'Status filters apply to preset views. Clear the search to use them.'
            )}
      </p>
    )
  }
  if (statuses.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('jira.statusFilters.unavailable', 'No statuses are available for this view yet.')}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="multiple"
          variant="segmented"
          size="xs"
          spacing={1}
          value={selectedJiraStatuses}
          disabled={disabled}
          aria-label={t('jira.statusFilters.label', 'Filter Jira issues by status')}
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
            {t('jira.statusFilters.clear', 'Clear statuses')}
          </Button>
        ) : null}
      </div>
      {selectedJiraStatuses.length ? (
        <>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={preview}
              aria-label={t('jira.statusFilters.jql', 'Status filter JQL')}
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
              {t('jira.statusFilters.editJql', 'Edit as JQL')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'jira.statusFilters.catalogHint',
              'Statuses come from loaded issues. Clear statuses to discover others in this view.'
            )}
          </p>
        </>
      ) : null}
    </div>
  )
}
