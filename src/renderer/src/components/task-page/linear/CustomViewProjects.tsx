import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { ChevronLeft, ExternalLink } from 'lucide-react'
import {
  LinearProjectTable,
  LinearCollectionNotice
} from '@/components/linear-project-view-surfaces'
export function TaskPageLinearCustomViewProjects({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    setTaskResumeState,
    selectedLinearWorkspaceId,
    setLinearProjectTab,
    selectedLinearCustomView,
    setSelectedLinearCustomView,
    setLinearProjectParentView,
    linearCustomViewProjectsResult,
    linearCustomViewContentsLoading,
    linearCustomViewContentsError,
    openLinearProjectContext
  } = model
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              setSelectedLinearCustomView(null)
              setLinearProjectParentView(null)
              setTaskResumeState({
                linearContext: undefined
              })
            }}
            aria-label={translate('auto.components.TaskPage.bc06ed0fb0', 'Back to views')}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">
              {selectedLinearCustomView!.name}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {translate('auto.components.TaskPage.733b8f2421', 'Linear / Views')}
            </div>
          </div>
        </div>
        {selectedLinearCustomView!.url ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void window.api.shell.openUrl(selectedLinearCustomView!.url!)}
            className="gap-1 border-border/50 bg-background/70"
          >
            <ExternalLink className="size-3.5" />
            {translate('auto.components.TaskPage.8675cd6188', 'Linear')}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto scrollbar-sleek">
        {linearCustomViewContentsError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {linearCustomViewContentsError}
          </div>
        ) : null}
        <LinearProjectTable
          projects={linearCustomViewProjectsResult.items}
          loading={linearCustomViewContentsLoading}
          hasError={!!linearCustomViewProjectsResult.errors?.length}
          workspaceSelection={selectedLinearWorkspaceId}
          onSelectProject={(project) =>
            openLinearProjectContext(project, {
              parentView: selectedLinearCustomView
            })
          }
          onOpenProject={(project) => {
            if (project.url) {
              void window.api.shell.openUrl(project.url)
            }
          }}
          onUseProjectIssues={(project) => {
            openLinearProjectContext(project, {
              parentView: selectedLinearCustomView
            })
            setLinearProjectTab('issues')
          }}
        />
      </div>
      <LinearCollectionNotice
        errors={linearCustomViewProjectsResult.errors}
        hasMore={linearCustomViewProjectsResult.hasMore}
        count={linearCustomViewProjectsResult.items.length}
        label={translate('auto.components.TaskPage.b39fe6511d', 'projects')}
      />
    </div>
  )
}
