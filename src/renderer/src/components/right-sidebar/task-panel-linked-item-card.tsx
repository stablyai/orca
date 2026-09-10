import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { openHttpLink } from '@/lib/http-link-routing'
import { translate } from '@/i18n/i18n'
import type { WorkspaceLinkedTask } from './workspace-linked-task'
import { WORKSPACE_LINKED_TASK_PROVIDER_LABELS } from './workspace-linked-task-labels'
import { useWorkspaceLinkedTaskDetail } from './use-workspace-linked-task-detail'

/** Fallback surface for providers whose detail view the panel does not host yet.
 *  Shows what the workspace stored plus whatever the provider cache holds, so
 *  the item is always identifiable and reachable. */
export function TaskPanelLinkedItemCard({
  task
}: {
  task: WorkspaceLinkedTask
}): React.JSX.Element {
  const detail = useWorkspaceLinkedTaskDetail(task)
  const providerLabel = WORKSPACE_LINKED_TASK_PROVIDER_LABELS[task.provider]
  const openLabel = translate('auto.components.rightSidebar.TaskPanel.openExternal', 'Open task')

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{task.reference}</span>
              <span aria-hidden="true">·</span>
              <span className="truncate">{providerLabel}</span>
              {detail.state ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate capitalize">{detail.state}</span>
                </>
              ) : null}
            </div>
            <div className="mt-1 text-sm leading-5 font-medium break-words text-foreground">
              {detail.title ||
                translate('auto.components.rightSidebar.TaskPanel.untitled', 'Untitled task')}
            </div>
          </div>
          {detail.url ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void openHttpLink(detail.url)}
                  aria-label={openLabel}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{openLabel}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {detail.description ? (
          <CommentMarkdown content={detail.description} variant="compact" />
        ) : (
          <div className="text-xs leading-5 text-muted-foreground">
            {detail.loading
              ? translate('auto.components.rightSidebar.TaskPanel.loading', 'Loading task details.')
              : detail.detailsLoaded
                ? translate(
                    'auto.components.rightSidebar.TaskPanel.descriptionEmpty',
                    'This task has no description.'
                  )
                : translate(
                    'auto.components.rightSidebar.TaskPanel.descriptionUnavailable',
                    'No description is readable here for this provider yet. Open the task to read it in full.'
                  )}
          </div>
        )}
      </div>
    </div>
  )
}
