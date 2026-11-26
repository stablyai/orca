import { useState } from 'react'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { cn } from '@/lib/class-names'
import TaskProjectSourceCombobox from '@/components/task-page/source-selection/task-project-source-combobox'
import { normalizeTaskRepoSelection } from '../../../../../shared/work-items/task-repo-selection'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { shouldSuppressEnterSubmit } from '@/lib/workspace/creation/new-workspace-enter-guard'
import { getGitLabMRInvolvementFilters } from '@/components/task-page/task-page-localized-options'
import { TaskFilterMenu } from '@/components/task-page/TaskFilterMenu'
import { normalizeGitLabLabelNames } from '../../../../../shared/gitlab/gitlab-label-names'
import { parseTaskQuery } from '../../../../../shared/work-items/task-query'
import { useGitLabLabelFilterOptions } from './use-gitlab-label-filter-options'

function FilterChip({
  label,
  active,
  onSelect
}: {
  label: string
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        'rounded-md border px-2 py-1 text-xs transition',
        active
          ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
          : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
      )}
    >
      {label}
    </button>
  )
}

export function TaskPageGitLabFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const {
    updateSettings,
    eligibleRepos,
    repoSelection,
    setRepoSelection,
    taskPickerGroups,
    taskPickerRepos,
    gitLabIssueFilters,
    gitLabMRFilters,
    getTaskPickerRepoHostLabel,
    setGitlabFilter,
    gitlabLoading,
    setGitlabRefreshNonce,
    gitlabView,
    setGitlabView,
    gitlabTodosLoading,
    activeGitlabFilter,
    gitlabMRInvolvement,
    setGitlabMRInvolvement,
    gitlabSearchInput,
    setGitlabSearchInput,
    setAppliedGitlabSearch,
    gitlabLabelScopeRepo,
    gitlabLabels,
    setGitlabLabels
  } = model
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  const labelOptions = useGitLabLabelFilterOptions(filterMenuOpen ? gitlabLabelScopeRepo : null)
  const gitlabSearchLabel =
    gitlabView === 'issues'
      ? t('auto.components.TaskPage.gitlabSearchIssues', 'Search GitLab issues or #123...')
      : t('auto.components.TaskPage.gitlabSearchMrs', 'Search GitLab merge requests...')
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 text-xs">
          {(['issues', 'mrs', 'todos'] as const).map((view) => {
            const active = gitlabView === view
            const label =
              view === 'issues'
                ? t('auto.components.TaskPage.gitlabViewIssues', 'Issues')
                : view === 'mrs'
                  ? t('auto.components.TaskPage.gitlabViewMrs', 'MRs')
                  : t('auto.components.TaskPage.gitlabViewTodos', 'My Todos')
            return (
              <button
                key={view}
                type="button"
                onClick={() => setGitlabView(view)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs transition',
                  active
                    ? 'border-foreground/40 bg-foreground/90 text-background'
                    : 'border-border/50 bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
        <div className="min-w-0 w-full sm:w-[200px]">
          <TaskProjectSourceCombobox
            groups={taskPickerGroups}
            selected={repoSelection}
            getRepoHostLabel={getTaskPickerRepoHostLabel}
            onChange={(next) => {
              const normalized = normalizeTaskRepoSelection(eligibleRepos, next)
              setRepoSelection(normalized)
              void updateSettings({
                defaultRepoSelection: [...normalized]
              }).catch(() => {
                toast.error(
                  t('auto.components.TaskPage.dfd72673e7', 'Failed to save project selection.')
                )
              })
            }}
            onSelectAll={() => {
              const allIds = new Set(taskPickerRepos.map((r) => r.id))
              setRepoSelection(allIds)
              void updateSettings({
                defaultRepoSelection: null
              }).catch(() => {
                toast.error(
                  t('auto.components.TaskPage.dfd72673e7', 'Failed to save project selection.')
                )
              })
            }}
            triggerClassName="h-8 w-full rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
          />
        </div>
        {gitlabView === 'todos' ? null : (
          <TaskFilterMenu
            parsed={{ ...parseTaskQuery(''), labels: gitlabLabels }}
            kind={gitlabView === 'issues' ? 'issues' : 'prs'}
            heading={
              gitlabView === 'mrs'
                ? t('auto.components.TaskPage.gitlabFilterMergeRequests', 'Filter merge requests')
                : undefined
            }
            sections={['label']}
            open={filterMenuOpen}
            onOpenChange={setFilterMenuOpen}
            labelOpts={labelOptions.options}
            labelsLoading={labelOptions.loading}
            labelsError={labelOptions.error}
            onChange={(change) => {
              if (change.labels) {
                // Why: the list requests keep only what this keeps, so the pill never shows more than is applied.
                setGitlabLabels(normalizeGitLabLabelNames(change.labels))
              }
            }}
          />
        )}
        {gitlabView === 'todos' ? null : (
          <div className="flex h-8 min-w-0 flex-1 basis-64 items-center gap-2 rounded-md border border-border/50 bg-background px-2.5 transition-[box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              surface="embedded"
              value={gitlabSearchInput}
              onChange={(e) => setGitlabSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') {
                  return
                }
                if (
                  shouldSuppressEnterSubmit(
                    { isComposing: e.nativeEvent.isComposing, shiftKey: e.shiftKey },
                    false
                  )
                ) {
                  return
                }
                e.preventDefault()
                const trimmed = gitlabSearchInput.trim()
                setGitlabSearchInput(trimmed)
                setAppliedGitlabSearch(trimmed)
                setGitlabRefreshNonce((n) => n + 1)
              }}
              placeholder={gitlabSearchLabel}
              aria-label={gitlabSearchLabel}
            />
            {gitlabSearchInput ? (
              <Button
                type="button"
                variant="muted-field-icon"
                size="icon-xs"
                aria-label={t('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
                onClick={() => {
                  setGitlabSearchInput('')
                  setAppliedGitlabSearch('')
                }}
                className="shrink-0"
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <div
        className="min-w-0 rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 pt-2 pb-0 shadow-sm"
        data-contextual-tour-target="tasks-search-presets"
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2">
              {gitlabView === 'issues' || gitlabView === 'mrs'
                ? (gitlabView === 'issues' ? gitLabIssueFilters : gitLabMRFilters).map(
                    ({ id, label }) => (
                      <FilterChip
                        key={id}
                        label={label}
                        active={activeGitlabFilter === id}
                        onSelect={() => {
                          setGitlabFilter(id)
                          setGitlabRefreshNonce((n) => n + 1)
                        }}
                      />
                    )
                  )
                : null}
            </div>
            {gitlabView === 'mrs' ? (
              <>
                <span aria-hidden className="h-4 w-px bg-border/60" />
                <div className="flex flex-wrap gap-2">
                  {getGitLabMRInvolvementFilters().map(({ id, label }) => (
                    <FilterChip
                      key={id ?? 'everyone'}
                      label={label}
                      active={gitlabMRInvolvement === id}
                      onSelect={() => {
                        setGitlabMRInvolvement(id)
                        setGitlabRefreshNonce((n) => n + 1)
                      }}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
          <div
            className="flex shrink-0 items-center gap-2"
            data-contextual-tour-target="tasks-actions"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setGitlabRefreshNonce((n) => n + 1)}
                  disabled={gitlabLoading || gitlabTodosLoading}
                  aria-label={
                    gitlabView === 'todos'
                      ? t('auto.components.TaskPage.c679af7ad9', 'Refresh My Todos')
                      : t('auto.components.TaskPage.d4c2830063', 'Refresh GitLab work items')
                  }
                  className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                >
                  {gitlabLoading || gitlabTodosLoading ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {gitlabView === 'todos'
                  ? t('auto.components.TaskPage.c679af7ad9', 'Refresh My Todos')
                  : t('auto.components.TaskPage.d4c2830063', 'Refresh GitLab work items')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </>
  )
}
