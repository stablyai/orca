import { useState } from 'react'
import { LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TaskRepoSourcePicker } from '../source-selection/TaskRepoSourcePicker'
import { TaskFilterChip } from '../TaskFilterChip'
import { GiteaNewIssueDialog } from './NewIssueDialog'
import { getGiteaTaskFilters, getGiteaTaskViews } from './gitea-task-options'
import { giteaTaskRepoScope } from './use-task-page-gitea-list'

export function TaskPageGiteaFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const t = useTranslate()
  const createGiteaIssue = useAppStore((s) => s.createGiteaIssue)
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  const {
    primaryRepo,
    giteaView,
    setGiteaView,
    giteaFilter,
    setGiteaFilter,
    giteaLoading,
    setGiteaRefreshNonce
  } = model
  const refreshLabel = t('auto.components.GiteaTaskList.e3db16e7c7', 'Refresh Gitea tasks')

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 text-xs">
          {getGiteaTaskViews().map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setGiteaView(id)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs transition',
                giteaView === id
                  ? 'border-foreground/40 bg-foreground/90 text-background'
                  : 'border-border/50 bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-w-0 w-full sm:w-[200px]">
          <TaskRepoSourcePicker model={model} />
        </div>
      </div>
      <div
        className="min-w-0 rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 pt-2 pb-0 shadow-sm"
        data-contextual-tour-target="tasks-search-presets"
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 pb-2">
          <div className="flex flex-wrap gap-2">
            {getGiteaTaskFilters().map(({ id, label }) => (
              <TaskFilterChip
                key={id}
                label={label}
                active={giteaFilter === id}
                onSelect={() => setGiteaFilter(id)}
              />
            ))}
          </div>
          <div
            className="flex shrink-0 items-center gap-2"
            data-contextual-tour-target="tasks-actions"
          >
            {primaryRepo ? (
              <Button variant="outline" size="sm" onClick={() => setNewIssueOpen(true)}>
                <Plus className="size-4" />
                {t('auto.components.GiteaTaskList.5997067bee', 'New issue')}
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setGiteaRefreshNonce((n) => n + 1)}
                  disabled={giteaLoading}
                  aria-label={refreshLabel}
                  className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                >
                  {giteaLoading ? (
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
      {primaryRepo ? (
        <GiteaNewIssueDialog
          open={newIssueOpen}
          onOpenChange={setNewIssueOpen}
          repoName={primaryRepo.displayName}
          onCreate={async (title, body) => {
            const result = await createGiteaIssue(giteaTaskRepoScope(primaryRepo), {
              title,
              body
            })
            if (!result.ok) {
              toast.error(result.error)
              return false
            }
            setGiteaRefreshNonce((n) => n + 1)
            return true
          }}
        />
      ) : null}
    </>
  )
}
