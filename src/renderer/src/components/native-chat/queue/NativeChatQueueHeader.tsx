import { AlertCircle, ChevronDown, ChevronRight, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentSessionHeldDelivery } from '../../../../../shared/agent-session/agent-session-held-delivery'
import type { QueuedMessagesPendingAction } from './use-structured-agent-session-queued-messages'
import { NativeChatPendingIcon } from './NativeChatPendingIcon'

export function NativeChatQueueHeader({
  count,
  attentionCaption,
  pause,
  queuePending,
  clearCapable,
  expanded,
  listId,
  onToggle,
  onClearAll,
  onResume
}: {
  count: number
  attentionCaption: string | null
  pause: {
    reason: string
    delivery?: AgentSessionHeldDelivery
  } | null
  queuePending: QueuedMessagesPendingAction | null
  clearCapable: boolean
  expanded: boolean
  listId: string
  onToggle?: () => void
  onClearAll: () => void
  onResume: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const toggleLabel = expanded
    ? t('components.native-chat.queuedMessages.collapse', 'Collapse')
    : t('components.native-chat.queuedMessages.expand', 'Expand')
  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-t-md py-1 pr-1 pl-2.5 text-xs text-muted-foreground',
        pause && 'bg-muted',
        !expanded && 'rounded-b-md'
      )}
    >
      <p className={cn('truncate', pause && 'font-medium text-foreground')}>
        {pause
          ? t('components.native-chat.queuedMessages.paused', 'Paused')
          : t('components.native-chat.queuedMessages.queued', 'Queued')}
      </p>
      <span aria-hidden>·</span>
      <span className={cn('tabular-nums', attentionCaption ? 'shrink-0' : 'min-w-0 flex-1')}>
        {count}
      </span>
      {attentionCaption ? (
        <span className="flex min-w-0 flex-1 items-center gap-1 text-destructive">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{attentionCaption}</span>
        </span>
      ) : null}
      {pause ? (
        <>
          {/* Each greys during the other: a Resume would send the cards a Clear is deleting. */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!clearCapable || queuePending !== null}
            onClick={onClearAll}
          >
            <NativeChatPendingIcon pending={queuePending === 'clear'} className="size-3">
              <Trash2 className="size-3" />
            </NativeChatPendingIcon>
            {t('components.native-chat.queuedMessages.clearAll', 'Clear all')}
          </Button>
          {!pause.delivery ||
          pause.delivery.reason.failure === 'sign-in' ||
          (pause.delivery.reason.failure === 'usage-limit' && !pause.delivery.resetsAt) ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={queuePending !== null}
              onClick={onResume}
            >
              <NativeChatPendingIcon pending={queuePending === 'resume'} className="size-3">
                <Play className="size-3" />
              </NativeChatPendingIcon>
              {t('components.native-chat.queuedMessages.resume', 'Resume')}
            </Button>
          ) : null}
        </>
      ) : null}
      {onToggle ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('components.native-chat.queuedMessages.listLabel', 'Queued messages')}
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={onToggle}
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {toggleLabel}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
