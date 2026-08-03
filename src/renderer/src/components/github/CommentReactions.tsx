import React from 'react'
import { translate } from '@/i18n/i18n'
import type { GitHubReaction } from '../../../../shared/types'

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

export function CommentReactions({
  reactions
}: {
  reactions?: GitHubReaction[]
}): React.JSX.Element | null {
  const visibleReactions = (reactions ?? []).filter((reaction) => reaction.count > 0)
  if (visibleReactions.length === 0) {
    return null
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {visibleReactions.map((reaction) => (
        <span
          key={reaction.content}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/35 px-2 text-[12px] leading-none text-foreground"
          aria-label={translate(
            'auto.components.GitHubItemDialog.a18f669c7a',
            '{{value0}} {{value1}} reaction{{value2}}',
            {
              value0: reaction.count,
              value1: reaction.content,
              value2: reaction.count === 1 ? '' : 's'
            }
          )}
        >
          <span aria-hidden="true">{REACTION_EMOJI[reaction.content]}</span>
          <span className="tabular-nums">{reaction.count}</span>
        </span>
      ))}
    </div>
  )
}
