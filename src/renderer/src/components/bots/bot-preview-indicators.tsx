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
  width,
  onPage
}: {
  direction: -1 | 1
  count: number
  attention: number
  signal: BotPreviewSignal
  width: number
  onPage: (direction: -1 | 1, keyboard: boolean) => void
}) {
  const t = useTranslate()
  if (count === 0) {
    return <span aria-hidden className="shrink-0" style={{ width }} />
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={accessibleLabel}
          className="pointer-events-auto relative flex h-5 shrink-0 cursor-pointer items-center justify-center rounded-md bg-muted text-3xs font-medium text-muted-foreground tabular-nums ring-2 ring-sidebar outline-none hover:text-foreground hover:ring-sidebar-ring focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid"
          style={{ width }}
          onClick={(event) => onPage(direction, event.detail === 0)}
        >
          {direction === -1 ? <ChevronLeft aria-hidden className="size-2 shrink-0" /> : null}+
          {count}
          {direction === 1 ? <ChevronRight aria-hidden className="size-2 shrink-0" /> : null}
          <BotPreviewPip signal={signal} animateWorking={false} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{accessibleLabel}</TooltipContent>
    </Tooltip>
  )
}

export function BotPreviewPip({
  signal,
  animateWorking
}: {
  signal: BotPreviewSignal
  animateWorking: boolean
}) {
  if (signal === 'attention') {
    return (
      <span className="pointer-events-none absolute -right-1 -bottom-1 z-10 flex size-3.5 items-center justify-center rounded-full bg-sidebar">
        <AgentQuestionIcon className="size-3" />
      </span>
    )
  }
  if (signal === 'working') {
    return (
      <span className="pointer-events-none absolute -right-1 -bottom-1 z-10 flex size-3 items-center justify-center rounded-full bg-sidebar">
        {animateWorking ? (
          <AgentWorkingSpinner className="size-2.5" />
        ) : (
          <CircleDashed aria-hidden className="size-2.5 text-agent-working" />
        )}
      </span>
    )
  }
  return signal === 'unread' ? (
    <span className={cn(unreadAlertDotClassName, 'z-10')} aria-hidden="true" />
  ) : null
}
