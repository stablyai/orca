import type { LucideIcon } from 'lucide-react'
import { ArrowRight, LoaderCircle, RefreshCw, Save, Send } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import type { JiraComment, JiraIssue } from '../../../shared/jira-types'

export type JiraIssueWorkspaceAction = {
  label: string
  icon: LucideIcon
  action: () => void
}

export function JiraIssueWorkspaceContent({
  displayed,
  titleDraft,
  setTitleDraft,
  labelsDraft,
  setLabelsDraft,
  handleSaveTitle,
  handleSaveLabels,
  pendingField,
  comments,
  commentsError,
  commentsLoading,
  retryComments,
  onUse,
  actionItems
}: {
  displayed: JiraIssue
  titleDraft: string
  setTitleDraft: (value: string) => void
  labelsDraft: string
  setLabelsDraft: (value: string) => void
  handleSaveTitle: () => void
  handleSaveLabels: () => void
  pendingField: string | null
  comments: JiraComment[]
  commentsError: string | null
  commentsLoading: boolean
  retryComments: () => void
  onUse: (issue: JiraIssue) => void
  actionItems: JiraIssueWorkspaceAction[]
}): React.JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_228px]">
      <div className="min-h-0 overflow-y-auto scrollbar-sleek">
        <section className="border-b border-border/40 px-4 py-4">
          <div className="grid gap-2">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.JiraIssueWorkspace.444865b4a8', 'Title')}
            </label>
            <div className="flex gap-2">
              <Input
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    handleSaveTitle()
                  }
                }}
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveTitle}
                disabled={pendingField === 'title'}
              >
                {pendingField === 'title' ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
              </Button>
            </div>
            <label className="mt-2 text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.JiraIssueWorkspace.aee97b6913', 'Labels')}
            </label>
            <div className="flex gap-2">
              <Input
                value={labelsDraft}
                onChange={(event) => setLabelsDraft(event.target.value)}
                placeholder={translate(
                  'auto.components.JiraIssueWorkspace.0f3c07a901',
                  'backend, bug'
                )}
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveLabels}
                disabled={pendingField === 'labels'}
              >
                {pendingField === 'labels' ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
              </Button>
            </div>
          </div>
        </section>

        <section className="border-b border-border/40 px-4 py-4">
          <div className="mb-2 flex items-center gap-2">
            <JiraIcon className="size-3 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">{displayed.issueType.name}</span>
            <span className="text-xs text-muted-foreground">
              {displayed.project.key} ·{' '}
              {displayed.assignee?.displayName ??
                translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned')}
            </span>
          </div>
          {displayed.description?.trim() ? (
            <CommentMarkdown
              content={displayed.description}
              variant="document"
              className="text-[14px] leading-relaxed"
            />
          ) : (
            <p className="text-sm italic text-muted-foreground">
              {translate(
                'auto.components.JiraIssueWorkspace.c4889a47e4',
                'No description provided.'
              )}
            </p>
          )}
        </section>

        <section className="px-4 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-foreground">
                {translate('auto.components.JiraIssueWorkspace.9a980b06b9', 'Comments')}
              </span>
              {comments.length > 0 ? (
                <span className="text-[12px] text-muted-foreground">{comments.length}</span>
              ) : null}
            </div>
            {commentsError ? (
              <Button
                variant="outline"
                size="xs"
                onClick={retryComments}
                disabled={commentsLoading}
                className="gap-1"
              >
                {commentsLoading ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                {translate('auto.components.JiraIssueWorkspace.5cd09beaf9', 'Retry')}
              </Button>
            ) : null}
          </div>
          {commentsError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {commentsError}
            </div>
          ) : commentsLoading && comments.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {translate('auto.components.JiraIssueWorkspace.9178090e26', 'No comments yet.')}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {comments.map((comment) => (
                <div key={comment.id} className="rounded-md border border-border/50 bg-muted/20">
                  <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                    {comment.user?.avatarUrl ? (
                      <img
                        src={comment.user.avatarUrl}
                        alt=""
                        className="size-5 shrink-0 rounded-full"
                      />
                    ) : null}
                    <span className="truncate text-[13px] font-semibold text-foreground">
                      {comment.user?.displayName ??
                        translate('auto.components.JiraIssueWorkspace.666cfdd835', 'Unknown')}
                    </span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      {formatUiRelativeTimeFromDate(comment.createdAt)}
                    </span>
                  </div>
                  <div className="px-3 py-2">
                    {/* Why: Jira comment screenshots need the same preview
                                affordance without changing compact comment typography. */}
                    <CommentMarkdown
                      content={comment.body}
                      expandImages
                      className="text-[13px] leading-relaxed"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <aside className="border-t border-border/50 bg-muted/20 px-3 py-3 xl:border-l xl:border-t-0">
        <Button
          onClick={() => onUse(displayed)}
          className="mb-3 w-full justify-center gap-2 sm:hidden"
        >
          {translate('auto.components.JiraIssueWorkspace.2441be6f9f', 'Start workspace')}
          <ArrowRight className="size-4" />
        </Button>
        <div className="grid gap-1">
          {actionItems.map((item) => {
            const Icon = item.icon
            return (
              <Tooltip key={item.label}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={item.action}
                    className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={6}>
                  {item.label}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

export function JiraIssueCommentComposer({
  commentDraft,
  setCommentDraft,
  commentSubmitting,
  canSubmitComment,
  handleSubmitComment
}: {
  commentDraft: string
  setCommentDraft: (value: string) => void
  commentSubmitting: boolean
  canSubmitComment: boolean
  handleSubmitComment: () => void
}): React.JSX.Element {
  return (
    <div className="flex-none border-t border-border/50 bg-background px-3 py-3">
      <div className="flex gap-2">
        <textarea
          value={commentDraft}
          onChange={(event) => setCommentDraft(event.target.value)}
          placeholder={translate(
            'auto.components.JiraIssueWorkspace.a585fd204e',
            'Add a Jira comment...'
          )}
          rows={2}
          disabled={commentSubmitting}
          className="min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button
          onClick={handleSubmitComment}
          disabled={!canSubmitComment || commentSubmitting}
          className="self-end gap-2"
        >
          {commentSubmitting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          {translate('auto.components.JiraIssueWorkspace.b0b92666c9', 'Comment')}
        </Button>
      </div>
    </div>
  )
}
