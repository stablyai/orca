import React from 'react'
import { Check, ChevronDown, Copy, MessageSquare, MoreHorizontal, Trash2 } from 'lucide-react'
import { DiffNotesSendMenu } from '@/components/editor/DiffNotesSendMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import type { PendingDiffCommentsClear } from './diff-comments-clear-dialog-state'
import { DiffCommentsInlineList } from './diff-comments-list'

export function SourceControlNotesShelf({
  activeWorktreeId,
  activeGroupId,
  diffCommentsForActive,
  diffCommentCount,
  diffCommentsExpanded,
  setDiffCommentsExpanded,
  diffCommentsCopied,
  handleCopyDiffComments,
  setPendingDiffCommentsClear,
  deleteDiffComment,
  handleOpenComment
}: {
  activeWorktreeId: string
  activeGroupId: string | null | undefined
  diffCommentsForActive: DiffComment[]
  diffCommentCount: number
  diffCommentsExpanded: boolean
  setDiffCommentsExpanded: React.Dispatch<React.SetStateAction<boolean>>
  diffCommentsCopied: boolean
  handleCopyDiffComments: () => Promise<void>
  setPendingDiffCommentsClear: React.Dispatch<React.SetStateAction<PendingDiffCommentsClear | null>>
  deleteDiffComment: (worktreeId: string, id: string) => Promise<void> | void
  handleOpenComment: (comment: DiffComment) => void
}): React.JSX.Element {
  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-1 pl-3 pr-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setDiffCommentsExpanded((prev) => !prev)}
          aria-expanded={diffCommentsExpanded}
          title={
            diffCommentsExpanded
              ? translate(
                  'auto.components.right.sidebar.SourceControl.d13edef890',
                  'Collapse notes'
                )
              : translate('auto.components.right.sidebar.SourceControl.72f2bea3f4', 'Expand notes')
          }
        >
          <ChevronDown
            className={cn(
              'size-3 shrink-0 transition-transform',
              !diffCommentsExpanded && '-rotate-90'
            )}
          />
          <MessageSquare className="size-3.5 shrink-0" />
          <span>
            {translate('auto.components.right.sidebar.SourceControl.cc474e0b8c', 'Notes')}
          </span>
          {diffCommentCount > 0 && (
            <span className="text-[11px] leading-none text-muted-foreground tabular-nums">
              {diffCommentCount}
            </span>
          )}
        </button>
        <div className="ml-1 flex shrink-0 items-center gap-1.5">
          <DiffNotesSendMenu
            worktreeId={activeWorktreeId}
            groupId={activeGroupId ?? activeWorktreeId}
            comments={diffCommentsForActive}
            triggerClassName="size-6"
            respondToOpenRequest
          />
          {diffCommentCount > 0 && (
            <TooltipProvider delayDuration={400}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => void handleCopyDiffComments()}
                    aria-label={translate(
                      'auto.components.right.sidebar.SourceControl.3baf6c77b4',
                      'Copy all notes to clipboard'
                    )}
                  >
                    {diffCommentsCopied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate(
                    'auto.components.right.sidebar.SourceControl.eae2d051af',
                    'Copy all notes'
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <DropdownMenu>
            <TooltipProvider delayDuration={400}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={translate(
                        'auto.components.right.sidebar.SourceControl.2fe2a67580',
                        'More note actions'
                      )}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate(
                    'auto.components.right.sidebar.SourceControl.2fe2a67580',
                    'More note actions'
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={diffCommentCount === 0}
                onSelect={() => {
                  if (!activeWorktreeId || diffCommentCount === 0) {
                    return
                  }
                  setPendingDiffCommentsClear({ kind: 'all', worktreeId: activeWorktreeId })
                }}
              >
                <Trash2 className="size-3.5" />
                {translate(
                  'auto.components.right.sidebar.SourceControl.1406954883',
                  'Clear all notes...'
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {diffCommentsExpanded && (
        <DiffCommentsInlineList
          comments={diffCommentsForActive}
          onDelete={(id) => void deleteDiffComment(activeWorktreeId, id)}
          onOpen={(comment) => handleOpenComment(comment)}
          onClearFile={(filePath) =>
            setPendingDiffCommentsClear({
              kind: 'file',
              worktreeId: activeWorktreeId,
              filePath
            })
          }
        />
      )}
    </div>
  )
}
