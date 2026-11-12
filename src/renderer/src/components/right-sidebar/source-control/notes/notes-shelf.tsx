import { useSourceControlScope, useSourceControlState } from '../panel/worktree-scope'
import { useDiffCommentView } from '@/components/diff-comments/use-diff-comment-owner'
import type { AppState } from '@/store/types'
import React from 'react'
import { Check, ChevronDown, Copy, MessageSquare, MoreHorizontal, Trash2 } from 'lucide-react'
import { DiffNotesSendMenu } from '@/components/editor/diff/review/DiffNotesSendMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
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
  deleteDiffComment: AppState['deleteDiffComment']
  handleOpenComment: (comment: DiffComment) => void
}): React.JSX.Element {
  const t = useTranslate()
  const scope = useSourceControlScope()
  const placementGroupId = useSourceControlState((s) =>
    scope ? s.activeGroupIdByWorktree[scope.placementWorkspaceId] : undefined
  )
  const { owner } = useDiffCommentView(activeWorktreeId, 'selection')
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
              ? t('auto.components.right.sidebar.SourceControl.d13edef890', 'Collapse notes')
              : t('auto.components.right.sidebar.SourceControl.72f2bea3f4', 'Expand notes')
          }
        >
          <ChevronDown
            className={cn(
              'size-3 shrink-0 transition-transform',
              !diffCommentsExpanded && '-rotate-90'
            )}
          />
          <MessageSquare className="size-3.5 shrink-0" />
          <span>{t('auto.components.right.sidebar.SourceControl.cc474e0b8c', 'Notes')}</span>
          {diffCommentCount > 0 && (
            <span className="text-[11px] leading-none text-muted-foreground tabular-nums">
              {diffCommentCount}
            </span>
          )}
        </button>
        <div className="ml-1 flex shrink-0 items-center gap-1.5">
          <DiffNotesSendMenu
            owner={owner}
            worktreeId={activeWorktreeId}
            groupId={placementGroupId ?? activeGroupId ?? activeWorktreeId}
            comments={diffCommentsForActive}
            triggerClassName="size-6"
            respondToOpenRequest
          />
          {diffCommentCount > 0 && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => void handleCopyDiffComments()}
                    aria-label={t(
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
                  {t('auto.components.right.sidebar.SourceControl.eae2d051af', 'Copy all notes')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <DropdownMenu>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={t(
                        'auto.components.right.sidebar.SourceControl.2fe2a67580',
                        'More note actions'
                      )}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {t('auto.components.right.sidebar.SourceControl.2fe2a67580', 'More note actions')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={diffCommentCount === 0}
                onSelect={() => {
                  if (!owner || !activeWorktreeId || diffCommentCount === 0) {
                    return
                  }
                  setPendingDiffCommentsClear({
                    kind: 'all',
                    worktreeId: activeWorktreeId,
                    owner,
                    count: diffCommentCount
                  })
                }}
              >
                <Trash2 className="size-3.5" />
                {t('auto.components.right.sidebar.SourceControl.1406954883', 'Clear all notes...')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {diffCommentsExpanded && (
        <DiffCommentsInlineList
          comments={diffCommentsForActive}
          onDelete={(id) => void (owner && deleteDiffComment(owner, id))}
          onOpen={(comment) => handleOpenComment(comment)}
          onClearFile={(filePath) =>
            owner &&
            setPendingDiffCommentsClear({
              kind: 'file',
              owner,
              worktreeId: activeWorktreeId,
              filePath,
              count: diffCommentsForActive.filter((comment) => comment.filePath === filePath).length
            })
          }
        />
      )}
    </div>
  )
}
