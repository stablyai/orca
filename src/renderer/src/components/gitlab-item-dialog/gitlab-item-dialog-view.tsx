import { CircleDot, ExternalLink, GitMerge, LoaderCircle, RefreshCw, Send, X } from 'lucide-react'
import { VisuallyHidden } from 'radix-ui'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle
} from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { hasBoundedCommentBodyText } from '@/lib/comment-body-submit-state'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import { normalizeGitLabLabels, StateBadge } from '../gitlab-item-dialog-parts'
import { GitLabConversationTab } from './gitlab-conversation-tab'
import { GitLabDescriptionTab } from './gitlab-description-tab'
import { GitLabFilesTab } from './gitlab-files-tab'
import { GitLabPipelineTab } from './gitlab-pipeline-tab'
import type { GitLabDetailsEditing } from './use-gitlab-details-editing'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'
import type { GitLabPipelineActions } from './use-gitlab-pipeline-actions'
import type { GitLabPrimaryActions } from './use-gitlab-primary-actions'
import type { GitLabReviewActions } from './use-gitlab-review-actions'

type Props = {
  item: GitLabWorkItem | null
  onClose: () => void
  onCreateWorkspace?: (item: GitLabWorkItem) => void
  state: GitLabItemDialogState
  detailsEditing: GitLabDetailsEditing
  pipelineActions: GitLabPipelineActions
  primaryActions: GitLabPrimaryActions
  reviewActions: GitLabReviewActions
  handleRefresh: () => void
  updateCommentDraft: (value: string) => void
}

export function GitLabItemDialogView({
  item,
  onClose,
  onCreateWorkspace,
  state,
  detailsEditing,
  pipelineActions,
  primaryActions,
  reviewActions,
  handleRefresh,
  updateCommentDraft
}: Props) {
  const { actionInFlight, commentDraft, commentSubmitting, details, error, loading } = state
  // Why: GitMerge for MRs visually disambiguates from GitBranch (and
  // matches gitlab.com's MR iconography); CircleDot stays on issues.
  const Icon = item?.type === 'mr' ? GitMerge : CircleDot
  const prefix = item?.type === 'mr' ? '!' : '#'
  const isMR = item?.type === 'mr'
  const canClose = isMR && item?.state === 'opened'
  const canReopen = isMR && item?.state === 'closed'
  const canMerge = isMR && item?.state === 'opened'
  const visibleTitle = details?.item.title || item?.title || ''
  const visibleLabels = normalizeGitLabLabels(details?.item.labels ?? item?.labels ?? [])
  const canSubmitComment = hasBoundedCommentBodyText(commentDraft)

  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Why: the sheet's absolute default close control would overlap this header's actions. */}
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <VisuallyHidden.Root>
          <SheetTitle>
            {item
              ? visibleTitle
              : translate('auto.components.GitLabItemDialog.3a051b8ade', 'Work item')}
          </SheetTitle>
          <SheetDescription>
            {translate('auto.components.GitLabItemDialog.30c97083c2', 'GitLab work item detail')}
          </SheetDescription>
        </VisuallyHidden.Root>

        {item ? (
          <>
            <header className="flex-none border-b border-border/40 px-5 py-4">
              <div className="flex items-start gap-3">
                <Icon className="mt-0.5 size-5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">
                      {prefix}
                      {item.number}
                    </span>
                    <StateBadge state={item.state} />
                    {item.author ? (
                      <span>
                        {translate('auto.components.GitLabItemDialog.9bfb4a24d7', 'by')}{' '}
                        {item.author}
                      </span>
                    ) : null}
                  </div>
                  <h2 className="mt-1.5 text-lg font-semibold leading-tight text-foreground">
                    {visibleTitle}
                  </h2>
                  {visibleLabels.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {visibleLabels.map((label) => (
                        <span
                          key={label}
                          className="rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={translate('auto.components.GitLabItemDialog.b3c156dd51', 'Refresh')}
                    disabled={loading}
                    onClick={handleRefresh}
                    className="size-7"
                  >
                    {loading ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                  </Button>
                  <SheetClose asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-7"
                      aria-label={translate('auto.components.GitLabItemDialog.a199eb364b', 'Close')}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </SheetClose>
                </div>
              </div>
            </header>

            <Tabs defaultValue="description" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-5 mt-3 self-start">
                <TabsTrigger value="description">
                  {translate('auto.components.GitLabItemDialog.908d8d2a73', 'Description')}
                </TabsTrigger>
                <TabsTrigger value="conversation">
                  {translate('auto.components.GitLabItemDialog.c996e2962c', 'Conversation')}
                  {details?.comments?.length ? (
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-medium">
                      {details.comments.length}
                    </span>
                  ) : null}
                </TabsTrigger>
                {isMR ? (
                  <TabsTrigger value="files">
                    {translate('auto.components.GitLabItemDialog.be3d291837', 'Files')}
                    {details?.files?.length ? (
                      <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-medium">
                        {details.files.length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                ) : null}
                {isMR ? (
                  <TabsTrigger value="pipeline">
                    {translate('auto.components.GitLabItemDialog.02cbe2de44', 'Pipeline')}
                    {details?.pipelineJobs?.length ? (
                      <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-medium">
                        {details.pipelineJobs.length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                ) : null}
              </TabsList>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-sleek">
                {error ? (
                  <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                ) : null}
                <GitLabDescriptionTab
                  item={item}
                  state={state}
                  detailsEditing={detailsEditing}
                  reviewActions={reviewActions}
                />
                <GitLabConversationTab item={item} state={state} reviewActions={reviewActions} />
                <GitLabFilesTab item={item} state={state} reviewActions={reviewActions} />
                <GitLabPipelineTab item={item} state={state} pipelineActions={pipelineActions} />
              </div>
            </Tabs>

            <footer className="flex-none space-y-3 border-t border-border/40 px-5 py-3">
              {/* Why: comment composer at the top of the footer so the
                  primary actions row stays visually grouped at the bottom. */}
              <div className="flex items-end gap-2">
                <textarea
                  value={commentDraft}
                  onChange={(event) => updateCommentDraft(event.target.value)}
                  placeholder={translate(
                    'auto.components.GitLabItemDialog.c08e1d5a57',
                    'Comment on {{value0}}{{value1}}…',
                    { value0: prefix, value1: item.number }
                  )}
                  rows={2}
                  disabled={commentSubmitting}
                  className="min-h-9 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
                  onKeyDown={(event) => {
                    // Why: this is local textarea submit behavior; Settings
                    // keybindings only cover app commands.
                    if (isScreenSubmitShortcut(event) && canSubmitComment && !commentSubmitting) {
                      event.preventDefault()
                      void primaryActions.handleSubmitComment()
                    }
                  }}
                />
                <Button
                  size="sm"
                  disabled={!canSubmitComment || commentSubmitting}
                  onClick={() => void primaryActions.handleSubmitComment()}
                  className="shrink-0 gap-1.5"
                >
                  {commentSubmitting ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                  {translate('auto.components.GitLabItemDialog.84012fa8fb', 'Comment')}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void window.api.shell.openUrl(item.url)}
                  className="gap-1.5"
                >
                  <ExternalLink className="size-3.5" />
                  {translate('auto.components.GitLabItemDialog.f2e64d1c20', 'Open in GitLab')}
                </Button>
                <div className="flex items-center gap-2">
                  {onCreateWorkspace ? (
                    <Button variant="outline" size="sm" onClick={() => onCreateWorkspace(item)}>
                      {translate('auto.components.GitLabItemDialog.131865e231', 'Create workspace')}
                    </Button>
                  ) : null}
                  {canMerge ? (
                    <Button
                      size="sm"
                      disabled={actionInFlight !== null}
                      onClick={() => void primaryActions.handleMerge()}
                    >
                      {actionInFlight === 'merge' ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : null}
                      {translate('auto.components.GitLabItemDialog.16b3412570', 'Merge')}
                    </Button>
                  ) : null}
                  {canClose ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionInFlight !== null}
                      onClick={() => void primaryActions.handleClose()}
                    >
                      {actionInFlight === 'close' ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : null}
                      {translate('auto.components.GitLabItemDialog.a199eb364b', 'Close')}
                    </Button>
                  ) : null}
                  {canReopen ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionInFlight !== null}
                      onClick={() => void primaryActions.handleReopen()}
                    >
                      {actionInFlight === 'reopen' ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : null}
                      {translate('auto.components.GitLabItemDialog.65e784c1f1', 'Reopen')}
                    </Button>
                  ) : null}
                </div>
              </div>
            </footer>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
