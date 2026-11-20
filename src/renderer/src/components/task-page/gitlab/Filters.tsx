import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { cn } from '@/lib/class-names'
import { TaskPageProjectSourcePicker } from '../task-page-project-source-picker'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { getGitLabMRInvolvementFilters } from '@/components/task-page/task-page-localized-options'

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
        <TaskPageProjectSourcePicker model={model} />
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
