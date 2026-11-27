import { TaskPageJiraStatusFilters } from './filters/TaskPageJiraStatusFilters'
import { TaskPageJiraSavedFilters } from './filters/TaskPageJiraSavedFilters'
import { TaskPageJiraFavouriteFilters } from './filters/TaskPageJiraFavouriteFilters'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { useRef } from 'react'
import { RailPagePrimaryButton, RailPageRefreshButton } from '@/components/rail-page/RailPageHeader'
import { RailPageSearch } from '@/components/rail-page/RailPageSearch'
import { RailPageFilterButton, RailPageViews } from '@/components/rail-page/RailPageToolbar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TaskPageListBands } from '../ListBands'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { getJiraProjectSelectionKey } from '@/components/task-page/jira/task-page-jira-project-selection'
import { useTranslate } from '@/i18n/use-translate'
import { LoaderCircle, Plus, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { shouldSuppressEnterSubmit } from '@/lib/workspace/creation/new-workspace-enter-guard'
import { JiraProjectPicker } from '@/components/task-page/jira/project-selection/jira-project-picker'
import { matchesJiraProject } from '../../../../../shared/jira/jira-project-reference'
export function TaskPageJiraFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
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
  const inputRef = useRef<HTMLInputElement>(null)
  const selectView = (view: typeof activeJiraPreset | 'workspace'): void => {
    setJiraSearchInput('')
    setAppliedJiraSearch('')
    if (view === 'workspace') {
      setJiraHasWorkspace(true)
      setTaskResumeState({ jiraQuery: '' })
      return
    }
    setJiraHasWorkspace(false)
    void clearJiraSavedFilterSelection().catch(() => {})
    setActiveJiraPreset(view)
    setTaskResumeState({ jiraPreset: view, jiraQuery: '' })
    setJiraRefreshNonce((n) => n + 1)
  }
  const activeView = jiraHasWorkspace
    ? 'workspace'
    : jiraSearchInput || model.jiraFavouriteFilter || jiraActiveSavedFilterId
      ? null
      : activeJiraPreset
  return (
    <TaskPageListBands
      model={model}
      scope={
        <JiraProjectPicker
          projects={sortedAvailableJiraProjects}
          value={model.jiraProjectFilter}
          onChange={model.setJiraProjectFilter}
          label={t('components.jiraProjectPicker.label', 'Jira project')}
          emptyLabel={t('components.jiraProjectPicker.all', 'All Jira projects')}
          triggerClassName="h-7 min-w-0 max-w-52 shrink"
          disabled={jiraProjectsLoading || jiraHasWorkspace}
        />
      }
      actions={
        <>
          <RailPageRefreshButton
            label={t('auto.components.TaskPage.2ff9fd71fd', 'Refresh Jira issues')}
            busy={jiraLoading}
            onRefresh={() => setJiraRefreshNonce((n) => n + 1)}
          />
          <RailPagePrimaryButton
            label={t('common.new', 'New')}
            aria-label={t('auto.components.TaskPage.0c11ca0b6d', 'New Jira issue')}
            disabled={sortedAvailableJiraProjects.length === 0 || jiraProjectsLoading}
            icon={
              jiraProjectsLoading ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" />
              )
            }
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
          />
        </>
      }
      views={
        <RailPageViews
          label={t('auto.components.TaskPage.9cd11ba218', 'Jira')}
          value={activeView}
          onValueChange={selectView}
          onReselect={selectView}
          items={[
            ...jiraPresets.map((preset) => ({
              value: preset.id,
              label: preset.label,
              disabled: jiraSavedFiltersPending
            })),
            { value: 'workspace', label: t('jira.workspace.mode', 'Has Workspace') }
          ]}
        />
      }
      controls={
        <>
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
          {!jiraHasWorkspace ? (
            <Popover>
              <PopoverTrigger asChild>
                <RailPageFilterButton activeCount={model.selectedJiraStatuses.length} />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80">
                <div className="p-3">
                  <TaskPageJiraStatusFilters model={model} />
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          <RailPageSearch
            inputRef={inputRef}
            hasValue={Boolean(jiraSearchInput)}
            disabled={jiraSavedFiltersPending}
          >
            <div className="relative min-w-0 w-full">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
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
                    ? t('jira.workspace.search', 'Search linked issues')
                    : t(
                        'auto.components.TaskPage.99c2755218',
                        'Search issues or enter JQL, e.g. project = ABC'
                      )
                }
                density="compact"
                surface="background"
                inset="leadingIcon"
                adornment={jiraSearchInput ? 'trailing' : 'shortcut'}
              />
              {jiraSearchInput ? (
                <button
                  type="button"
                  aria-label={t('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
                  onClick={() => {
                    inputRef.current?.focus({ preventScroll: true })
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
          </RailPageSearch>
        </>
      }
      notices={
        jiraSavedFiltersError || (!jiraHasWorkspace && model.jiraQuickFiltersError) ? (
          <>
            {jiraSavedFiltersError ? (
              <p role="alert" className="text-xs text-destructive">
                {jiraSavedFiltersError}
              </p>
            ) : null}
            {!jiraHasWorkspace && model.jiraQuickFiltersError ? (
              <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
                <span>{model.jiraQuickFiltersError}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={model.jiraQuickFiltersLoading || model.jiraQuickFiltersPending}
                  onClick={model.retryJiraQuickFilters}
                >
                  {t('jira.savedFilters.retry', 'Retry')}
                </Button>
              </div>
            ) : null}
          </>
        ) : null
      }
    />
  )
}
