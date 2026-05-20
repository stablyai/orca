import React, { useMemo } from 'react'
import { Send } from 'lucide-react'
import type { DiffComment } from '../../../../shared/types'
import { useAppStore } from '@/store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { cn } from '@/lib/utils'

export function DiffNotesSendMenu({
  worktreeId,
  groupId,
  comments,
  filePath,
  showFileScope = false,
  triggerClassName,
  iconClassName = 'size-3.5',
  align = 'end'
}: {
  worktreeId: string
  groupId: string
  comments: readonly DiffComment[]
  filePath?: string
  showFileScope?: boolean
  triggerClassName?: string
  iconClassName?: string
  align?: 'start' | 'center' | 'end'
}): React.JSX.Element {
  const markDiffCommentsSent = useAppStore((s) => s.markDiffCommentsSent)
  const unsentNotes = useMemo(() => comments.filter((comment) => !comment.sentAt), [comments])
  const unsentNoteIds = useMemo(() => unsentNotes.map((comment) => comment.id), [unsentNotes])
  const unsentPrompt = useMemo(() => formatDiffComments(unsentNotes), [unsentNotes])
  const fileNotes = useMemo(
    () => (filePath ? comments.filter((comment) => comment.filePath === filePath) : []),
    [comments, filePath]
  )
  const unsentFileNotes = useMemo(() => fileNotes.filter((comment) => !comment.sentAt), [fileNotes])
  const unsentFileNoteIds = useMemo(
    () => unsentFileNotes.map((comment) => comment.id),
    [unsentFileNotes]
  )
  const unsentFilePrompt = useMemo(() => formatDiffComments(unsentFileNotes), [unsentFileNotes])
  const hasUnsentNotes = unsentNotes.length > 0
  const canSendFileScope = showFileScope && Boolean(filePath)

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
                triggerClassName
              )}
              disabled={!hasUnsentNotes}
              aria-label="Send notes to a new agent"
              onClick={(event) => event.stopPropagation()}
            >
              <Send className={iconClassName} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {hasUnsentNotes ? 'Send notes to a new agent' : 'All notes sent'}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align={align} className="min-w-[220px]">
        {canSendFileScope ? (
          <>
            <DropdownMenuLabel>Send notes</DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={unsentFileNotes.length === 0}>
                This file
                <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                  {unsentFileNotes.length}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[180px]">
                <QuickLaunchAgentMenuItems
                  worktreeId={worktreeId}
                  groupId={groupId}
                  onFocusTerminal={focusTerminalTabSurface}
                  prompt={unsentFilePrompt}
                  promptDelivery="submit-after-ready"
                  launchSource="notes_send"
                  onPromptDelivered={() => void markDiffCommentsSent(worktreeId, unsentFileNoteIds)}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={unsentNotes.length === 0}>
                All unsent notes
                <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                  {unsentNotes.length}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[180px]">
                <QuickLaunchAgentMenuItems
                  worktreeId={worktreeId}
                  groupId={groupId}
                  onFocusTerminal={focusTerminalTabSurface}
                  prompt={unsentPrompt}
                  promptDelivery="submit-after-ready"
                  launchSource="notes_send"
                  onPromptDelivered={() => void markDiffCommentsSent(worktreeId, unsentNoteIds)}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        ) : (
          <QuickLaunchAgentMenuItems
            worktreeId={worktreeId}
            groupId={groupId}
            onFocusTerminal={focusTerminalTabSurface}
            prompt={unsentPrompt}
            promptDelivery="submit-after-ready"
            launchSource="notes_send"
            onPromptDelivered={() => void markDiffCommentsSent(worktreeId, unsentNoteIds)}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
