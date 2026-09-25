import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { cn } from '@/lib/utils'
import { TaskPageSourceBar } from './SourceBar'
import { AlertCircle } from 'lucide-react'
import { TaskPageGitHubModeControls } from './github/ModeControls'
import { TaskPageProviderFilters } from './ProviderFilters'
import { useAppStore } from '@/store'
export function TaskPageListChrome({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const { taskSourceAvailabilityNotice, taskPageListChromeHidden } = model
  const selectedPluginTaskSource = useAppStore((state) => state.selectedPluginTaskSource)
  return (
    <div className={cn('flex-none flex flex-col gap-2', taskPageListChromeHidden && 'hidden')}>
      <section className="flex flex-col gap-2">
        <div className="flex flex-col gap-2">
          <TaskPageSourceBar model={model} />

          {taskSourceAvailabilityNotice ? (
            <div
              role="status"
              className="flex max-w-3xl items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              title={taskSourceAvailabilityNotice.title}
            >
              <AlertCircle className="size-3.5 flex-none" />
              <span className="min-w-0 truncate">{taskSourceAvailabilityNotice.label}</span>
            </div>
          ) : null}

          {/* A contributed source owns the whole list surface; the built-in
              provider's mode and filter toolbars would describe a list that
              isn't showing. */}
          {selectedPluginTaskSource ? null : (
            <>
              <TaskPageGitHubModeControls model={model} />

              <TaskPageProviderFilters model={model} />
            </>
          )}
        </div>
      </section>
    </div>
  )
}
