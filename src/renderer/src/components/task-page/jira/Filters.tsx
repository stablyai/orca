import { TaskPageJiraStatusFilters } from './TaskPageJiraStatusFilters'
import { TaskPageJiraSavedFilters } from '../../TaskPageJiraSavedFilters'
import { TaskPageJiraFavouriteFilters } from './TaskPageJiraFavouriteFilters'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { getJiraProjectSelectionKey } from '@/components/task-page/jira/task-page-jira-project-selection'
import { translate } from '@/i18n/i18n'
import { LoaderCircle, Plus, RefreshCw, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import { JiraProjectPicker } from '@/components/jira-project-picker'
import { matchesJiraProject } from '../../../../../shared/jira/jira-project-reference'
export function TaskPageJiraFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    jiraSavedFilters,
    jiraActiveSavedFilterId,
    jiraSavedFiltersReady,
    jiraSavedFiltersLoading,
    jiraSavedFiltersPending,
    jiraSavedFiltersError,
    retryJiraSavedFilters,
    applyJiraSavedFilter,
    createJiraSavedFilter,
    updateJiraSavedFilter,
    deleteJiraSavedFilter,
    clearJiraSavedFilterSelection,
    setTaskResumeState,
    jiraPresets,
    jiraHasWorkspace,
    setJiraHasWorkspace,
    jiraLoading,
    jiraSearchInput,
    setJiraSearchInput,
    setAppliedJiraSearch,
    activeJiraPreset,
    setActiveJiraPreset,
    setJiraRefreshNonce,
    jiraProjectsLoading,
    setNewJiraIssueOpen,
    setNewJiraIssueTitle,
    setNewJiraIssueBody,
    setNewJiraIssueProjectId,
    setNewJiraIssueProjectQuery,
    setNewJiraIssueProjectCommandValue,
    setNewJiraIssueTypeId,
    sortedAvailableJiraProjects
  } = model
  return (
    <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 pt-2 pb-0 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <div className="min-w-0 max-w-64">
            <JiraProjectPicker
              projects={sortedAvailableJiraProjects}
              value={model.jiraProjectFilter}
              onChange={model.setJiraProjectFilter}
              label={translate('components.jiraProjectPicker.label', 'Jira project')}
              emptyLabel={translate('components.jiraProjectPicker.all', 'All Jira projects')}
              disabled={jiraProjectsLoading || jiraHasWorkspace}
            />
          </div>
          {jiraPresets.map((preset) => {
            const active =
              !jiraHasWorkspace &&
              !jiraSearchInput &&
              !model.jiraFavouriteFilter &&
              activeJiraPreset === preset.id
            return (
              <button
                key={preset.id}
                disabled={jiraSavedFiltersPending}
                type="button"
                onClick={() => {
                  setJiraHasWorkspace(false)
                  void clearJiraSavedFilterSelection().catch(() => {})
                  setJiraSearchInput('')
                  setAppliedJiraSearch('')
                  setActiveJiraPreset(preset.id)
                  setTaskResumeState({
                    jiraPreset: preset.id,
                    jiraQuery: ''
                  })
                  setJiraRefreshNonce((n) => n + 1)
                }}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition',
                  active
                    ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                    : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                )}
              >
                {preset.label}
              </button>
            )
          })}
          <Button
            variant={jiraHasWorkspace ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={jiraHasWorkspace}
            onClick={() => {
              setJiraHasWorkspace(true)
              setJiraSearchInput('')
              setAppliedJiraSearch('')
              setTaskResumeState({ jiraQuery: '' })
            }}
          >
            {translate('jira.workspace.mode', 'Has Workspace')}
          </Button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TaskPageJiraFavouriteFilters key={model.jiraTaskSourceScopeKey} model={model} />
          <TaskPageJiraSavedFilters
            filters={jiraSavedFilters}
            activeFilterId={jiraActiveSavedFilterId}
            currentJql={jiraSearchInput}
            disabled={!jiraSavedFiltersReady || jiraSavedFiltersPending}
            loading={jiraSavedFiltersLoading}
            error={jiraSavedFiltersError}
            onRetry={retryJiraSavedFilters}
            onApply={async (filter) => {
              if (await applyJiraSavedFilter(filter)) {
                setJiraHasWorkspace(false)
              }
            }}
            onCreate={createJiraSavedFilter}
            onUpdate={updateJiraSavedFilter}
            onDelete={deleteJiraSavedFilter}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  // Why: restore dismissed typed text (accidental dismissal recoverable); pickers keep their fresh open-time defaults.
                  const draft = useAppStore.getState().newJiraIssueDraft
                  setNewJiraIssueTitle(draft?.title ?? '')
                  setNewJiraIssueBody(draft?.body ?? '')
                  const projectFilter = model.jiraProjectFilter
                  const defaultProject = projectFilter
                    ? sortedAvailableJiraProjects.find((project) =>
                        matchesJiraProject(project, projectFilter)
                      )
                    : null
                  const project = defaultProject ?? sortedAvailableJiraProjects[0]
                  setNewJiraIssueProjectId(project ? getJiraProjectSelectionKey(project) : null)
                  setNewJiraIssueProjectQuery('')
                  setNewJiraIssueProjectCommandValue('')
                  setNewJiraIssueTypeId(null)
                  setNewJiraIssueOpen(true)
                }}
                disabled={sortedAvailableJiraProjects.length === 0 || jiraProjectsLoading}
                aria-label={translate('auto.components.TaskPage.0c11ca0b6d', 'New Jira issue')}
                className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
              >
                {jiraProjectsLoading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.0c11ca0b6d', 'New Jira issue')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setJiraRefreshNonce((n) => n + 1)}
                disabled={jiraLoading}
                aria-label={translate('auto.components.TaskPage.2ff9fd71fd', 'Refresh Jira issues')}
                className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
              >
                {jiraLoading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.2ff9fd71fd', 'Refresh Jira issues')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      {jiraSavedFiltersError ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {jiraSavedFiltersError}
        </p>
      ) : null}
      <TaskPageJiraStatusFilters model={model} />
      <div className="mt-3 flex items-center gap-3">
        <div className="relative min-w-[320px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={jiraSearchInput}
            disabled={jiraSavedFiltersPending}
            onChange={(e) => {
              void clearJiraSavedFilterSelection().catch(() => {})
              setJiraSearchInput(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (
                  shouldSuppressEnterSubmit(
                    {
                      isComposing: e.nativeEvent.isComposing,
                      shiftKey: e.shiftKey
                    },
                    false
                  )
                ) {
                  return
                }
                e.preventDefault()
                const trimmed = jiraSearchInput.trim()
                setJiraSearchInput(trimmed)
                setAppliedJiraSearch(trimmed)
                setTaskResumeState({
                  jiraQuery: trimmed
                })
                if (!jiraHasWorkspace) {
                  setJiraRefreshNonce((n) => n + 1)
                }
              }
            }}
            placeholder={
              jiraHasWorkspace
                ? translate('jira.workspace.search', 'Search linked issues')
                : translate(
                    'auto.components.TaskPage.99c2755218',
                    'Search issues or enter JQL, e.g. project = ABC'
                  )
            }
            className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
          />
          {jiraSearchInput ? (
            <button
              type="button"
              aria-label={translate('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
              onClick={() => {
                void clearJiraSavedFilterSelection().catch(() => {})
                setJiraSearchInput('')
                setAppliedJiraSearch('')
                setTaskResumeState({
                  jiraQuery: ''
                })
                if (!jiraHasWorkspace) {
                  setJiraRefreshNonce((n) => n + 1)
                }
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
