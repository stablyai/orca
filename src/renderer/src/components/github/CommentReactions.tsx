import React from 'react'
import { SmilePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { GITHUB_REACTION_ORDER } from '@/lib/pr-comment-reactions'
import type { GitHubReaction, GitHubReactionContent } from '../../../../shared/types'

const REACTION_EMOJI: Record<GitHubReaction['content'], string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  confused: '😕',
  heart: '❤️',
  hooray: '🎉',
  rocket: '🚀',
  eyes: '👀'
}

const REACTION_LABEL: Record<GitHubReactionContent, string> = {
  '+1': 'thumbs up',
  '-1': 'thumbs down',
  laugh: 'laugh',
  confused: 'confused',
  heart: 'heart',
  hooray: 'hooray',
  rocket: 'rocket',
  eyes: 'eyes'
}

export function CommentReactions({
  reactions,
  className,
  onReactionChange
}: {
  reactions?: GitHubReaction[]
  className?: string
  onReactionChange?: (
    content: GitHubReactionContent,
    reacted: boolean
  ) => Promise<boolean> | boolean
}): React.JSX.Element | null {
  const visibleReactions = (reactions ?? []).filter((reaction) => reaction.count > 0)
  const addReactionButtonRef = React.useRef<HTMLButtonElement>(null)
  const pickerGroupRef = React.useRef<HTMLDivElement>(null)
  const mutationPendingRef = React.useRef(false)
  const [open, setOpen] = React.useState(false)
  const [pendingContent, setPendingContent] = React.useState<GitHubReactionContent | null>(null)
  if (visibleReactions.length === 0 && !onReactionChange) {
    return null
  }

  const changeReaction = async (
    content: GitHubReactionContent,
    reacted: boolean,
    closePicker: boolean,
    focusTriggerAfterChange = false
  ): Promise<void> => {
    if (!onReactionChange || mutationPendingRef.current) {
      return
    }
    mutationPendingRef.current = true
    setPendingContent(content)
    if (focusTriggerAfterChange) {
      addReactionButtonRef.current?.focus()
    }
    try {
      const changed = await onReactionChange(content, reacted)
      if (changed && closePicker) {
        setOpen(false)
      }
    } finally {
      mutationPendingRef.current = false
      setPendingContent(null)
    }
  }

  const pickerLabel = translate(
    'auto.components.github.CommentReactions.addReaction',
    'Add reaction'
  )

  return (
    <div className={cn('mt-2 flex flex-wrap items-center gap-1.5', className)}>
      {visibleReactions.map((reaction) => (
        <React.Fragment key={reaction.content}>
          {onReactionChange ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-disabled={pendingContent !== null}
              className={cn(
                'h-6 gap-1 rounded-full px-2 text-[12px] font-normal',
                reaction.viewerHasReacted && 'border-ring bg-accent text-accent-foreground'
              )}
              aria-pressed={Boolean(reaction.viewerHasReacted)}
              aria-label={translate(
                'auto.components.GitHubItemDialog.a18f669c7a',
                '{{value0}} {{value1}} reaction{{value2}}',
                {
                  value0: reaction.count,
                  value1: REACTION_LABEL[reaction.content],
                  value2: reaction.count === 1 ? '' : 's'
                }
              )}
              onClick={() =>
                void changeReaction(
                  reaction.content,
                  !reaction.viewerHasReacted,
                  false,
                  Boolean(reaction.viewerHasReacted && reaction.count === 1)
                )
              }
            >
              <span aria-hidden="true">{REACTION_EMOJI[reaction.content]}</span>
              <span className="tabular-nums">{reaction.count}</span>
            </Button>
          ) : (
            <span
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/35 px-2 text-[12px] leading-none text-foreground"
              aria-label={translate(
                'auto.components.GitHubItemDialog.a18f669c7a',
                '{{value0}} {{value1}} reaction{{value2}}',
                {
                  value0: reaction.count,
                  value1: REACTION_LABEL[reaction.content],
                  value2: reaction.count === 1 ? '' : 's'
                }
              )}
            >
              <span aria-hidden="true">{REACTION_EMOJI[reaction.content]}</span>
              <span className="tabular-nums">{reaction.count}</span>
            </span>
          )}
        </React.Fragment>
      ))}
      {onReactionChange ? (
        <Popover open={open} onOpenChange={(nextOpen) => !pendingContent && setOpen(nextOpen)}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  ref={addReactionButtonRef}
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-disabled={pendingContent !== null}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={pickerLabel}
                >
                  <SmilePlus className="size-3.5" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {pickerLabel}
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            align="start"
            side="top"
            sideOffset={6}
            className="w-auto p-1.5"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              pickerGroupRef.current?.focus()
            }}
          >
            <div
              ref={pickerGroupRef}
              className="grid grid-cols-4 gap-1"
              aria-label={pickerLabel}
              role="group"
              tabIndex={-1}
            >
              {GITHUB_REACTION_ORDER.map((content) => {
                const reaction = reactions?.find((candidate) => candidate.content === content)
                const reacted = Boolean(reaction?.viewerHasReacted)
                return (
                  <Button
                    key={content}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-disabled={pendingContent !== null}
                    className={cn('text-lg', reacted && 'bg-accent text-accent-foreground')}
                    aria-label={
                      reacted
                        ? translate(
                            'auto.components.github.CommentReactions.removeNamedReaction',
                            'Remove {{value0}} reaction',
                            { value0: REACTION_LABEL[content] }
                          )
                        : translate(
                            'auto.components.github.CommentReactions.addNamedReaction',
                            'Add {{value0}} reaction',
                            { value0: REACTION_LABEL[content] }
                          )
                    }
                    aria-pressed={reacted}
                    onClick={() => void changeReaction(content, !reacted, true)}
                  >
                    <span aria-hidden="true">{REACTION_EMOJI[content]}</span>
                  </Button>
                )
              })}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
