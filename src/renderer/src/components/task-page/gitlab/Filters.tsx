import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RailPageRefreshButton } from '@/components/rail-page/RailPageHeader'
import { RailPageFilterButton, RailPageViews } from '@/components/rail-page/RailPageToolbar'
import { getGitLabMRInvolvementFilters } from '@/components/task-page/task-page-localized-options'
import { TaskPageListBands } from '../ListBands'
import { TaskPageRepositoryScope } from '../RepositoryScope'

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
    gitLabIssueFilters,
    gitLabMRFilters,
    setGitlabFilter,
    gitlabLoading,
    setGitlabRefreshNonce,
    gitlabView,
    setGitlabView,
    gitlabTodosLoading,
    activeGitlabFilter,
    gitlabMRInvolvement,
    setGitlabMRInvolvement
  } = model
  const refresh = (
    <RailPageRefreshButton
      label={
        gitlabView === 'todos'
          ? t('auto.components.TaskPage.c679af7ad9', 'Refresh My Todos')
          : t('auto.components.TaskPage.d4c2830063', 'Refresh GitLab work items')
      }
      busy={gitlabLoading || gitlabTodosLoading}
      onRefresh={() => setGitlabRefreshNonce((n) => n + 1)}
    />
  )
  const controls =
    gitlabView !== 'todos' ? (
      <Popover>
        <PopoverTrigger asChild>
          <RailPageFilterButton
            activeCount={
              Number(activeGitlabFilter !== 'opened') +
              Number(gitlabView === 'mrs' && gitlabMRInvolvement !== null)
            }
          />
        </PopoverTrigger>
        <PopoverContent align="end">
          <div className="flex flex-wrap items-center gap-2 p-2">
            <div className="flex flex-wrap gap-2">
              {(gitlabView === 'issues' ? gitLabIssueFilters : gitLabMRFilters).map(
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
              )}
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
        </PopoverContent>
      </Popover>
    ) : null
  return (
    <TaskPageListBands
      model={model}
      scope={<TaskPageRepositoryScope model={model} />}
      views={
        <RailPageViews
          label={t('auto.components.TaskPage.11a828abf8', 'GitLab')}
          value={gitlabView}
          onValueChange={setGitlabView}
          onReselect={setGitlabView}
          items={[
            { value: 'issues', label: t('auto.components.TaskPage.gitlabViewIssues', 'Issues') },
            { value: 'mrs', label: t('auto.components.TaskPage.gitlabViewMrs', 'MRs') },
            { value: 'todos', label: t('auto.components.TaskPage.gitlabViewTodos', 'My Todos') }
          ]}
        />
      }
      actions={refresh}
      controls={controls}
    />
  )
}
