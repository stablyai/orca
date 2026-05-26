import React, { useMemo } from 'react'
import { Send, Sparkles } from 'lucide-react'
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
  triggerLabel,
  triggerCount,
  actionLabel,
  iconClassName = 'size-3.5',
  align = 'end'
}: {
  worktreeId: string
  groupId: string
  comments: readonly DiffComment[]
  filePath?: string
  showFileScope?: boolean
  triggerClassName?: string
  triggerLabel?: string
  triggerCount?: number
  actionLabel?: string
  iconClassName?: string
  align?: 'start' | 'center' | 'end'
}): React.JSX.Element {
  const clearDeliveredDiffComments = useAppStore((s) => s.clearDeliveredDiffComments)
  const unsentNotes = useMemo(() => comments.filter((comment) => !comment.sentAt), [comments])
  const unsentPrompt = useMemo(() => formatDiffComments(unsentNotes), [unsentNotes])
  const fileNotes = useMemo(
    () => (filePath ? comments.filter((comment) => comment.filePath === filePath) : []),
    [comments, filePath]
  )
  const unsentFileNotes = useMemo(() => fileNotes.filter((comment) => !comment.sentAt), [fileNotes])
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
              aria-label={
                triggerLabel ? `Send ${triggerLabel} to a new agent` : 'Send notes to a new agent'
              }
              onClick={(event) => event.stopPropagation()}
            >
              {triggerLabel ? (
                <>
                  <Sparkles className="size-3 text-violet-500 dark:text-violet-400" />
                  <span className="whitespace-nowrap">{triggerLabel}</span>
                  {triggerCount !== undefined ? (
                    <span className="rounded-full bg-background/80 px-1 text-[10px] tabular-nums text-muted-foreground">
                      {triggerCount}
                    </span>
                  ) : null}
                  <span className="mx-0.5 h-3 w-px bg-border/70" aria-hidden />
                </>
              ) : null}
              <Send className={iconClassName} />
              {actionLabel ? <span className="whitespace-nowrap">{actionLabel}</span> : null}
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
              <DropdownMenuSubTrigger
                disabled={unsentFileNotes.length === 0}
                className="[&>svg:last-child]:ml-0"
              >
                <NoteScopeMenuRow label="This file" count={unsentFileNotes.length} />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[180px]">
                <QuickLaunchAgentMenuItems
                  worktreeId={worktreeId}
                  groupId={groupId}
                  onFocusTerminal={focusTerminalTabSurface}
                  prompt={unsentFilePrompt}
                  promptDelivery="submit-after-ready"
                  launchSource="notes_send"
                  onPromptDelivered={() =>
                    void clearDeliveredDiffComments(worktreeId, unsentFileNotes)
                  }
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                disabled={unsentNotes.length === 0}
                className="[&>svg:last-child]:ml-0"
              >
                <NoteScopeMenuRow label="All unsent notes" count={unsentNotes.length} />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[180px]">
                <QuickLaunchAgentMenuItems
                  worktreeId={worktreeId}
                  groupId={groupId}
                  onFocusTerminal={focusTerminalTabSurface}
                  prompt={unsentPrompt}
                  promptDelivery="submit-after-ready"
                  launchSource="notes_send"
                  onPromptDelivered={() => void clearDeliveredDiffComments(worktreeId, unsentNotes)}
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
            onPromptDelivered={() => void clearDeliveredDiffComments(worktreeId, unsentNotes)}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function NoteScopeMenuRow({ label, count }: { label: string; count: number }): React.JSX.Element {
  return (
    <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
      <span className="truncate">{label}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </span>
  )
}
