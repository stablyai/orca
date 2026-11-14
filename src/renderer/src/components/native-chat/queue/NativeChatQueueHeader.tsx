import type { Ref } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { QueuedMessagesPendingAction } from './use-structured-agent-session-queued-messages'
import { NativeChatPendingIcon } from './NativeChatPendingIcon'

/** "Queued · N" (or a paused queue's warning, Clear all and Resume) and the fold chevron. */
export function NativeChatQueueHeader({
  foldRef,
  count,
  attentionCaption,
  pause,
  queuePending,
  clearCapable,
  expanded,
  foldDisabled,
  listId,
  onToggle,
  onClearAll,
  onResume
}: {
  foldRef: Ref<HTMLButtonElement>
  count: number
  attentionCaption: string | null
  pause: { reason: string } | null
  queuePending: QueuedMessagesPendingAction | null
  clearCapable: boolean
  expanded: boolean
  /** A row is mid-drag: folding would drop it. */
  foldDisabled: boolean
  listId: string
  onToggle: () => void
  onClearAll: () => void
  onResume: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const toggleLabel = expanded
    ? t('components.native-chat.queuedMessages.collapse', 'Collapse')
    : t('components.native-chat.queuedMessages.expand', 'Expand')
  return (
    <div
      data-native-chat-dock-pinned
      className={cn(
        'flex min-h-7 shrink-0 items-center gap-1.5 pr-1 pl-2.5 text-xs font-medium',
        pause ? 'text-chat-warning' : 'text-muted-foreground'
      )}
    >
      {pause ? <Pause aria-hidden className="size-3.5 shrink-0" /> : null}
      <p className={cn('tabular-nums', attentionCaption ? 'shrink-0' : 'min-w-0 flex-1 truncate')}>
        {pause
          ? t('components.native-chat.queuedMessages.paused', 'Paused')
          : t('components.native-chat.queuedMessages.queued', 'Queued')}
        {` · ${count}`}
      </p>
      {attentionCaption ? (
        <span className="flex min-w-0 flex-1 items-center gap-1 font-normal text-destructive">
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
        </>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={foldRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('components.native-chat.queuedMessages.listLabel', 'Queued messages')}
            aria-expanded={expanded}
            aria-controls={listId}
            disabled={foldDisabled}
            onClick={onToggle}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {toggleLabel}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
