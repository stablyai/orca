import { useEffect, useState } from 'react'
import { ArrowRight, Check, ExternalLink, LoaderCircle, X } from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'
import type { TodoistComment, TodoistTask } from '../../../../../shared/todoist-types'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { getTodoistPriorityLabel } from './todoist-task-order'
import { TodoistTaskStatusBadge } from './TaskStatusBadge'

export function TodoistTaskDrawer({
  task,
  onClose,
  onStartWorkspace,
  onCompleted
}: {
  task: TodoistTask | null
  onClose: () => void
  onStartWorkspace: (task: TodoistTask) => void
  onCompleted: (taskId: string) => void
}): React.JSX.Element {
  const [comments, setComments] = useState<TodoistComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [completing, setCompleting] = useState(false)
  const taskId = task?.id ?? null

  useEffect(() => {
    setComments([])
    if (!taskId) {
      return
    }
    let cancelled = false
    setCommentsLoading(true)
    window.api.todoist
      .getComments({ taskId })
      .then((result) => !cancelled && setComments(result))
      .catch(() => !cancelled && setComments([]))
      .finally(() => !cancelled && setCommentsLoading(false))
    return () => {
      cancelled = true
    }
  }, [taskId])

  const handleComplete = async (target: TodoistTask): Promise<void> => {
    setCompleting(true)
    try {
      const result = await window.api.todoist.closeTask({ id: target.id })
      if (result.ok) {
        onCompleted(target.id)
      } else {
        toast.error(result.error)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setCompleting(false)
    }
  }

  return (
    <Sheet open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,640px)] sm:max-w-[640px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {task?.content ?? translate('auto.components.TodoistTaskDrawer.title', 'Todoist task')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.TodoistTaskDrawer.description',
              'Preview, complete, and start work from the selected task.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>
        {task ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <TodoistTaskStatusBadge completed={task.completed} />
                    {task.projectName ? <span>{task.projectName}</span> : null}
                    <span>{getTodoistPriorityLabel(task.priority)}</span>
                    {task.due ? <span>{task.due.string ?? task.due.date}</span> : null}
                    {task.labels.map((label) => (
                      <span key={label}>@{label}</span>
                    ))}
                  </div>
                  <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
                    {task.content}
                  </h2>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={onClose}
                  aria-label={translate(
                    'auto.components.TodoistTaskDrawer.close',
                    'Close Todoist task preview'
                  )}
                >
                  <X className="size-4" />
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => onStartWorkspace(task)}>
                  {translate('auto.components.TodoistTaskDrawer.start', 'Start workspace')}
                  <ArrowRight className="size-4" />
                </Button>
                {task.completed ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={completing}
                    onClick={() => void handleComplete(task)}
                  >
                    {completing ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Check className="size-4" />
                    )}
                    {translate('auto.components.TodoistTaskDrawer.complete', 'Complete')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => window.api.shell.openUrl(task.url)}
                >
                  <ExternalLink className="size-4" />
                  {translate('auto.components.TodoistTaskDrawer.open', 'Open in Todoist')}
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 scrollbar-sleek">
              {task.description.trim() ? (
                <CommentMarkdown
                  content={task.description}
                  variant="document"
                  className="text-[14px] leading-relaxed"
                />
              ) : (
                <p className="text-sm italic text-muted-foreground">
                  {translate('auto.components.TodoistTaskDrawer.noDescription', 'No description.')}
                </p>
              )}
              <section>
                <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {translate('auto.components.TodoistTaskDrawer.comments', 'Comments')}
                </h3>
                {commentsLoading ? (
                  <LoaderCircle className="mt-3 size-4 animate-spin text-muted-foreground" />
                ) : comments.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {translate('auto.components.TodoistTaskDrawer.noComments', 'No comments.')}
                  </p>
                ) : (
                  <ul className="mt-2 space-y-3">
                    {comments.map((comment) => (
                      <li key={comment.id} className="rounded-md border border-border/50 px-3 py-2">
                        {comment.postedAt ? (
                          <div className="mb-1 text-[11px] text-muted-foreground">
                            {formatUiRelativeTimeFromDate(comment.postedAt)}
                          </div>
                        ) : null}
                        <CommentMarkdown content={comment.content} className="text-[13px]" />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
