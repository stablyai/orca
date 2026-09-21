import React from 'react'
import {
  ArrowRight,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  Plus,
  X
} from 'lucide-react'
import { VisuallyHidden } from 'radix-ui'

import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LinearIssueTextEditor } from '@/components/LinearIssueTextEditor'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { LinearIssueEditSection } from '@/components/linear-item-drawer-edit-section'
import { LinearIssueCommentFooter } from '@/components/linear-item-drawer-comment-footer'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import type { LinearComment, LinearIssue } from '../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { Worktree } from '../../../shared/worktree/types'
import type { LinearEditState, LinearLocalComment } from '@/components/linear-item-drawer-types'

function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

function formatRelativeTime(input: string): string {
  return formatUiRelativeTimeFromDate(input)
}

type LinearItemDrawerSheetProps = {
  issue: LinearIssue | null
  onClose: () => void
  displayed: LinearIssue | null
  handleIssueTextChange: Parameters<typeof LinearIssueTextEditor>[0] extends {
    onIssueChange: infer Handler
  }
    ? Handler
    : never
  sourceContext: TaskSourceContext | null | undefined
  editState: LinearEditState | null
  handleEditStateChange: (patch: Partial<LinearEditState>) => void
  commentsLoading: boolean
  comments: LinearComment[]
  handleCommentAdded: (comment: LinearLocalComment) => void
  attachedWorkspaceLabel: string | null
  attachedWorkspace: Worktree | null
  handleOpenOrUseIssue: () => void
  onUse: (issue: LinearIssue) => void
}

export function renderLinearItemDrawerSheet({
  issue,
  onClose,
  displayed,
  handleIssueTextChange,
  sourceContext,
  editState,
  handleEditStateChange,
  commentsLoading,
  comments,
  handleCommentAdded,
  attachedWorkspaceLabel,
  attachedWorkspace,
  handleOpenOrUseIssue,
  onUse
}: LinearItemDrawerSheetProps): React.JSX.Element {
  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full p-0 sm:max-w-[640px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {displayed?.title ??
              translate('auto.components.LinearItemDrawer.39883467f4', 'Linear issue')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.LinearItemDrawer.04a442f796',
              'Preview and edit the selected Linear issue.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed && (
          <div className="flex h-full min-h-0 flex-col">
            {/* Header */}
            <div className="flex-none border-b border-border/60 px-4 py-3">
              <div className="flex items-start gap-2">
                <LinearIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-[12px] text-muted-foreground">
                    {displayed.identifier}
                  </span>
                  <div className="mt-1">
                    <LinearIssueTextEditor
                      issue={displayed}
                      onIssueChange={handleIssueTextChange}
                      density="drawer"
                      fields="title"
                      sourceContext={sourceContext}
                    />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    {displayed.workspaceName && <span>{displayed.workspaceName}</span>}
                    {displayed.team?.name && <span>{displayed.team.name}</span>}
                    <span>· {formatRelativeTime(displayed.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => window.api.shell.openUrl(displayed.url)}
                        aria-label={translate(
                          'auto.components.LinearItemDrawer.0190b760c1',
                          'Open on Linear'
                        )}
                      >
                        <ExternalLink className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {translate('auto.components.LinearItemDrawer.0190b760c1', 'Open on Linear')}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={onClose}
                        aria-label={translate(
                          'auto.components.LinearItemDrawer.858d0630da',
                          'Close preview'
                        )}
                      >
                        <X className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {translate('auto.components.LinearItemDrawer.9dc54172db', 'Close · Esc')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>

            {/* Edit section */}
            {editState && (
              <LinearIssueEditSection
                issue={displayed}
                editState={editState}
                onEditStateChange={handleEditStateChange}
                sourceContext={sourceContext}
              />
            )}

            {/* Body + comments */}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
              <div className="px-4 py-4">
                <LinearIssueTextEditor
                  issue={displayed}
                  onIssueChange={handleIssueTextChange}
                  density="drawer"
                  fields="description"
                  sourceContext={sourceContext}
                />
              </div>

              <div className="border-t border-border/40 px-4 py-4">
                <div className="flex items-center gap-2 pb-3">
                  <span className="text-[13px] font-medium text-foreground">
                    {translate('auto.components.LinearItemDrawer.fde849b2b6', 'Comments')}
                  </span>
                  {comments.length > 0 && (
                    <span className="text-[12px] text-muted-foreground">{comments.length}</span>
                  )}
                </div>
                {commentsLoading && comments.length === 0 ? (
                  <div className="flex items-center justify-center py-6">
                    <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                  </div>
                ) : comments.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    {translate('auto.components.LinearItemDrawer.a4fcc57522', 'No comments yet.')}
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {comments.map((comment) => (
                      <div
                        key={comment.id}
                        className="rounded-lg border border-border/40 bg-background/30"
                      >
                        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                          {comment.user?.avatarUrl && (
                            <img
                              src={comment.user.avatarUrl}
                              alt={comment.user.displayName}
                              className="size-5 shrink-0 rounded-full"
                            />
                          )}
                          <span className="text-[13px] font-semibold text-foreground">
                            {comment.user?.displayName ??
                              translate('auto.components.LinearItemDrawer.48e17e8cbd', 'Unknown')}
                          </span>
                          <span className="text-[12px] text-muted-foreground">
                            · {formatRelativeTime(comment.createdAt)}
                          </span>
                        </div>
                        <div className="px-3 py-2">
                          <CommentMarkdown
                            content={comment.body}
                            className="text-[13px] leading-relaxed"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Comment footer + Start/Open workspace */}
            <LinearIssueCommentFooter
              issueId={displayed.id}
              workspaceId={displayed.workspaceId}
              onCommentAdded={handleCommentAdded}
              sourceContext={sourceContext}
            />
            <div className="flex-none space-y-2 border-t border-border/60 bg-background/40 px-4 py-3">
              {attachedWorkspaceLabel ? (
                <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="truncate">{attachedWorkspaceLabel}</span>
                </div>
              ) : null}
              {attachedWorkspace ? (
                <DropdownMenu modal={false}>
                  <ButtonGroup className="w-full">
                    <Button
                      onClick={handleOpenOrUseIssue}
                      className="flex-1 justify-center gap-2"
                      aria-label={translate(
                        'auto.components.LinearItemDrawer.openAttachedWorkspace',
                        'Open workspace attached to issue'
                      )}
                    >
                      <FolderOpen className="size-4" />
                      {translate(
                        'auto.components.LinearItemDrawer.openWorkspace',
                        'Open workspace'
                      )}
                    </Button>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        aria-label={translate(
                          'auto.components.LinearItemDrawer.moreWorkspaceActions',
                          'More issue workspace actions'
                        )}
                      >
                        <ChevronDown className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </ButtonGroup>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onUse(displayed)}>
                      <Plus className="size-4" />
                      {translate(
                        'auto.components.LinearItemDrawer.startNewWorkspace',
                        'Start new workspace'
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  onClick={handleOpenOrUseIssue}
                  className="w-full justify-center gap-2"
                  aria-label={translate(
                    'auto.components.LinearItemDrawer.04008e6c46',
                    'Start workspace from issue'
                  )}
                >
                  {translate(
                    'auto.components.LinearItemDrawer.04008e6c46',
                    'Start workspace from issue'
                  )}
                  <ArrowRight className="size-4" />
                </Button>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
