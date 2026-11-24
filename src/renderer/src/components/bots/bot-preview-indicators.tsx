import { ChevronLeft, ChevronRight, CircleDashed } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import { unreadAlertDotClassName } from '@/components/sidebar/workspace-card/surface/WorktreeCardStatusSlot'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotPreviewSignal } from '../../../../shared/bots/bot-collapsed-preview'

export function BotPreviewEdge({
  direction,
  count,
  attention,
  signal,
  onPage
}: {
  direction: -1 | 1
  count: number
  attention: number
  signal: BotPreviewSignal
  onPage: (direction: -1 | 1, keyboard: boolean) => void
}) {
  const t = useTranslate()
  if (count === 0) {
    return null
  }
  const action =
    direction === -1
      ? t('bots.section.scrollLeft', 'Scroll left · {{amount}} hidden', { amount: count })
      : t('bots.section.scrollRight', 'Scroll right · {{amount}} hidden', { amount: count })
  const hint = attention
    ? t('bots.connectors.needYou', '{{count}} need you', {
        count: attention,
        defaultValue_one: '{{count}} needs you'
      })
    : signal === 'unread'
      ? t('bots.chats.unread', 'Unread')
      : signal === 'working'
        ? t('sidebar.cardSlot.working', 'Working')
        : null
  const accessibleLabel = hint ? `${action} · ${hint}` : action
  const Chevron = direction === -1 ? ChevronLeft : ChevronRight
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={accessibleLabel}
          className={cn(
            'pointer-events-auto absolute inset-y-0 z-30 grid w-3 cursor-pointer place-items-center from-worktree-sidebar to-transparent text-worktree-sidebar-foreground/85 outline-none hover:text-worktree-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-worktree-sidebar-ring',
            direction === -1 ? 'left-0 bg-linear-to-r' : 'right-0 bg-linear-to-l'
          )}
          onClick={(event) => onPage(direction, event.detail === 0)}
        >
          <Chevron aria-hidden className="size-2.5" />
          <BotPreviewPip signal={signal} onEdge />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{accessibleLabel}</TooltipContent>
    </Tooltip>
  )
}

export function BotPreviewPip({
  signal,
  onEdge = false
}: {
  signal: BotPreviewSignal
  onEdge?: boolean
}) {
  if (signal === null) {
    return null
  }
  if (signal === 'unread') {
    return (
      <span
        className={cn(unreadAlertDotClassName, 'z-10', onEdge && 'right-0.5 -bottom-0.5')}
        aria-hidden="true"
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute z-10 flex size-3 items-center justify-center rounded-full',
        onEdge ? 'right-0 -bottom-1 bg-worktree-sidebar' : '-right-1 -bottom-1 bg-sidebar',
        !onEdge && signal === 'attention' && 'size-3.5'
      )}
    >
      {signal === 'attention' ? (
        <AgentQuestionIcon className={onEdge ? 'size-2.5' : 'size-3'} />
      ) : onEdge ? (
        <CircleDashed aria-hidden className="size-2.5 text-agent-working" />
      ) : (
        <AgentWorkingSpinner className="size-2.5" />
      )}
    </span>
  )
}
