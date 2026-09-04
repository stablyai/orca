import React from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

/**
 * Sentence for the pill. Two keys per side rather than an i18next `count` suffix, which is
 * how the rest of the app spells its plurals (see the workspace-cleanup copy).
 *
 * **"Unseen", never "needs you" and never "unread".** The pill counts `permission` AND
 * `unread`; the state chip labelled "Needs You" (`agentStateLabel('attention')`) counts
 * `permission` alone, and the toolbar's Unread toggle counts `hasUnread` alone. Saying
 * "2 sessions below need you" and then showing 0 under that chip — while the filter hides the
 * two cards the pill pointed at — is the same words for two different sets. `session-grid-
 * offscreen-attention.test.ts` fails if this copy borrows either other phrase.
 */
export function offscreenAttentionLabel(direction: 'above' | 'below', count: number): string {
  if (direction === 'above') {
    return count === 1
      ? translate(
          'auto.components.session.grid.SessionGridOffscreenAttentionPill.54a50fe32f',
          '{{count}} unseen session above',
          { count }
        )
      : translate(
          'auto.components.session.grid.SessionGridOffscreenAttentionPill.67c954bd0e',
          '{{count}} unseen sessions above',
          { count }
        )
  }
  return count === 1
    ? translate(
        'auto.components.session.grid.SessionGridOffscreenAttentionPill.213f12b348',
        '{{count}} unseen session below',
        { count }
      )
    : translate(
        'auto.components.session.grid.SessionGridOffscreenAttentionPill.956f07e0bb',
        '{{count}} unseen sessions below',
        { count }
      )
}

/**
 * A card asking for you can sit two screens away with nothing on screen to say so. This
 * floats over the grid, says which way and how many, and scrolls to the nearest one.
 *
 * Orange (`--agent-question`), not the unread amber: it means "you are needed", and it
 * stands for a `permission` card as readily as an unread one.
 */
export function SessionGridOffscreenAttentionPill({
  direction,
  count,
  onClick
}: {
  direction: 'above' | 'below'
  count: number
  onClick: () => void
}): React.JSX.Element {
  const label = offscreenAttentionLabel(direction, count)
  const Chevron = direction === 'above' ? ChevronUp : ChevronDown

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 z-40 flex justify-center',
        direction === 'above' ? 'top-2' : 'bottom-2'
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={label}
            data-testid="session-grid-offscreen-attention"
            data-direction={direction}
            onClick={onClick}
            className={cn(
              'pointer-events-auto h-6 gap-1 rounded-full px-2 text-[11px] font-medium',
              'bg-agent-question/15 text-agent-question-text ring-1 ring-inset ring-agent-question/25',
              'hover:bg-agent-question/25 hover:text-agent-question-text',
              'animate-in fade-in-0 duration-150 motion-reduce:animate-none'
            )}
          >
            <Chevron className="size-3" />
            {count}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={direction === 'above' ? 'bottom' : 'top'} sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
