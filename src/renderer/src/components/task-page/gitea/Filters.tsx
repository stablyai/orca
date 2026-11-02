import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { GiteaFilterSelect } from './FilterSelect'
import { LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import type { GiteaTaskView } from '../task-page-localized-options'
import { TaskPageProjectSourcePicker } from '../task-page-project-source-picker'
import { TaskPageGiteaIssueDialog } from './IssueDialog'
import {
  giteaAssigneeOptions,
  giteaAuthorOptions,
  giteaLabelOptions,
  giteaStateFiltersFor
} from './gitea-task-filters'

const GITEA_VIEWS: readonly GiteaTaskView[] = ['issues', 'prs', 'notifications']

function giteaViewLabel(view: GiteaTaskView): string {
  switch (view) {
    case 'issues':
      return translate('auto.components.TaskPage.giteaViewIssues', 'Issues')
    case 'prs':
      return translate('auto.components.TaskPage.giteaViewPrs', 'PRs')
    case 'notifications':
      return translate('auto.components.TaskPage.giteaViewNotifications', 'Notifications')
  }
}

export function TaskPageGiteaFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    gitLabMRFilters,
    setGiteaFilter,
    giteaLoading,
    setGiteaRefreshNonce,
    giteaView,
    setGiteaView,
    giteaNotificationsLoading,
    activeGiteaFilter,
    selectedRepos,
    giteaItems,
    giteaItemFilters,
    setGiteaItemFilters,
    giteaAssigneeFilter,
    setGiteaAssigneeFilter,
    giteaLabels,
    giteaAssignableUsers
  } = model
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  const stateFilters = giteaStateFiltersFor(giteaView).map((id) => ({
    id,
    label: gitLabMRFilters.find((filter) => filter.id === id)?.label ?? id
  }))
  const setItemFilter = (patch: Partial<typeof giteaItemFilters>): void =>
    setGiteaItemFilters((current) => ({ ...current, ...patch }))
  const refreshLabel =
    giteaView === 'notifications'
      ? translate('auto.components.TaskPage.giteaRefreshNotifications', 'Refresh notifications')
      : translate('auto.components.TaskPage.giteaRefreshWorkItems', 'Refresh Gitea work items')
  const busy = giteaLoading || giteaNotificationsLoading
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 text-xs">
          {GITEA_VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => setGiteaView(view)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs transition',
                giteaView === view
                  ? 'border-foreground/40 bg-foreground/90 text-background'
                  : 'border-border/50 bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              {giteaViewLabel(view)}
            </button>
          ))}
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
              {giteaView === 'notifications'
                ? null
                : stateFilters.map(({ id, label }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setGiteaFilter(id)
                        setGiteaRefreshNonce((n) => n + 1)
                      }}
                      className={cn(
                        'rounded-md border px-2 py-1 text-xs transition',
                        activeGiteaFilter === id
                          ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                          : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                      )}
                    >
                      {label}
                    </button>
                  ))}
            </div>
            {giteaView === 'notifications' ? null : (
              <>
                <Input
                  value={giteaItemFilters.search}
                  onChange={(e) => setItemFilter({ search: e.target.value })}
                  placeholder={translate(
                    'auto.components.TaskPage.giteaFilterSearch',
                    'Search title or #number'
                  )}
                  aria-label={translate(
                    'auto.components.TaskPage.giteaFilterSearchLabel',
                    'Search Gitea work items'
                  )}
                  className="h-7 w-44 text-xs"
                />
                <GiteaFilterSelect
                  label={translate('auto.components.TaskPage.giteaFilterAuthor', 'Author')}
                  value={giteaItemFilters.author}
                  options={giteaAuthorOptions(giteaItems)}
                  onChange={(author) => setItemFilter({ author })}
                />
                {giteaView === 'issues' ? (
                  <GiteaFilterSelect
                    label={translate('auto.components.TaskPage.giteaFilterAssignee', 'Assignee')}
                    value={giteaAssigneeFilter}
                    options={giteaAssigneeOptions(giteaAssignableUsers)}
                    onChange={(assignee) => {
                      setGiteaAssigneeFilter(assignee)
                      setGiteaRefreshNonce((n) => n + 1)
                    }}
                  />
                ) : null}
                <GiteaFilterSelect
                  label={translate('auto.components.TaskPage.giteaFilterLabel', 'Label')}
                  value={giteaItemFilters.label}
                  options={giteaLabelOptions(giteaItems, giteaLabels)}
                  onChange={(label) => setItemFilter({ label })}
                />
              </>
            )}
          </div>
          <div
            className="flex shrink-0 items-center gap-2"
            data-contextual-tour-target="tasks-actions"
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNewIssueOpen(true)}
              disabled={selectedRepos.length === 0}
            >
              <Plus className="size-3.5" />
              {translate('auto.components.TaskPage.giteaNewIssue', 'New issue')}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setGiteaRefreshNonce((n) => n + 1)}
                  disabled={busy}
                  aria-label={refreshLabel}
                  className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                >
                  {busy ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {refreshLabel}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
      <TaskPageGiteaIssueDialog model={model} open={newIssueOpen} onOpenChange={setNewIssueOpen} />
    </>
  )
}
