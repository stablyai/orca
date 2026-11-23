import React from 'react'
import * as VisuallyHidden from 'radix-ui/visually-hidden'
import { ArrowRight, ExternalLink, LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { hasBoundedCommentBodyText } from '@/lib/source-control/review/comments/comment-body-submit-state'
import type { ClickUpTask } from '../../../../../../shared/clickup/clickup-types'
import type { TaskSourceContext } from '../../../../../../shared/work-items/task-source-context'
import { clickUpTaskLocation } from '../listing/clickup-task-list'
import {
  ClickUpTaskCommentComposer,
  ClickUpTaskContent,
  ClickUpTaskMetadataBar
} from './clickup-task-workspace-sections'
import { useClickUpTaskDetail } from './use-clickup-task-detail'

function ClickUpTaskWorkspaceBody({
  task,
  sourceContext,
  onUse,
  onClose
}: {
  task: ClickUpTask
  sourceContext: TaskSourceContext
  onUse: (task: ClickUpTask) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const detail = useClickUpTaskDetail(task, sourceContext)
  const { displayed } = detail
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Why: the sheet spans the window top, so inset the actions below the fixed Windows/Linux controls overlay. */}
      <div className="flex-none border-b border-border/50 bg-muted/30 py-3 pl-4 pr-[max(1rem,var(--window-controls-width,0px))]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span className="font-mono">{displayed.customId ?? displayed.id}</span>
              <span className="min-w-0 truncate">{clickUpTaskLocation(displayed)}</span>
              <span>
                {formatUiRelativeTimeFromDate(displayed.updatedAt, undefined, intlLocale)}
              </span>
              {detail.taskLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
            </div>
            <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
              {displayed.name}
            </h2>
          </div>
          <Button
            onClick={() => onUse(displayed)}
            className="hidden shrink-0 sm:inline-flex"
            size="sm"
          >
            {t('auto.components.JiraIssueWorkspace.2441be6f9f', 'Start workspace')}
            <ArrowRight className="size-4" />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={(event) => openAppHttpLink(displayed.url, { event })}
                aria-label={t('taskProviders.clickup.openInClickUp', 'Open in ClickUp')}
              >
                <ExternalLink className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('taskProviders.clickup.openInClickUp', 'Open in ClickUp')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={onClose}
                aria-label={t('taskProviders.clickup.closePreview', 'Close ClickUp task preview')}
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('auto.components.JiraIssueWorkspace.7a96985ca0', 'Close')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ClickUpTaskMetadataBar
        task={displayed}
        statusOptions={detail.statusOptions}
        statusesLoading={detail.statusesLoading}
        statusesError={detail.statusesError}
        retryStatuses={detail.retryStatuses}
        pendingStatus={detail.pendingStatus}
        onChangeStatus={(status) => void detail.changeStatus(status)}
      />

      <ClickUpTaskContent
        task={displayed}
        taskError={detail.taskError}
        comments={detail.comments}
        commentsLoading={detail.commentsLoading}
        commentsError={detail.commentsError}
        retryComments={detail.retryComments}
        onUse={onUse}
      />

      <ClickUpTaskCommentComposer
        commentDraft={detail.commentDraft}
        setCommentDraft={detail.setCommentDraft}
        commentSubmitting={detail.commentSubmitting}
        canSubmitComment={hasBoundedCommentBodyText(detail.commentDraft)}
        onSubmit={() => void detail.submitComment()}
      />
    </div>
  )
}

export default function ClickUpTaskWorkspace({
  task,
  sourceContext,
  onUse,
  onClose
}: {
  task: ClickUpTask | null
  sourceContext: TaskSourceContext | null
  onUse: (task: ClickUpTask) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Sheet open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] sm:max-w-[780px]"
        onOpenAutoFocus={(event) => {
          // Why: default focus lands on the header's first control and pops its tooltip; the sheet itself still takes focus from the row behind.
          event.preventDefault()
          if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.focus()
          }
        }}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {task?.name ?? t('taskProviders.clickup.taskTitle', 'ClickUp task')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {t(
              'taskProviders.clickup.previewDescription',
              'Preview, update the status of, comment on, and start work from the selected task.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>
        {task && sourceContext ? (
          <ClickUpTaskWorkspaceBody
            key={`${task.workspaceId}:${task.id}`}
            task={task}
            sourceContext={sourceContext}
            onUse={onUse}
            onClose={onClose}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
