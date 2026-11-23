import type { Ref } from 'react'
import { AlertCircle, ChevronDown, ChevronUp, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { QueuedMessagesPendingAction } from './use-structured-agent-session-queued-messages'
import { NativeChatPendingIcon } from './NativeChatPendingIcon'

export function NativeChatQueueHeader({
  foldRef,
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
  foldRef: Ref<HTMLButtonElement>
  count: number
  attentionCaption: string | null
  pause: { reason: string } | null
  queuePending: QueuedMessagesPendingAction | null
  clearCapable: boolean
  expanded: boolean
  listId: string
  onToggle: () => void
  onClearAll: () => void
  onResume: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = pause
    ? t('components.native-chat.queuedMessages.paused', 'Paused')
    : t('components.native-chat.queuedMessages.queued', 'Queued')
  // Rows already show how many are queued; only a collapsed list needs the count.
  const hiddenCount = t('components.native-chat.queuedMessages.queuedCount', '{{count}} queued', {
    count,
    defaultValue_one: '{{count}} queued'
  })
  return (
    <div data-native-chat-dock-pinned className="flex h-8 items-center gap-1 px-1.5">
      {count === 0 ? (
        // Only agent mail is waiting, drawn in the transcript: nothing to fold here.
        <span className="flex h-6 min-w-0 flex-1 items-center px-1.5 font-medium text-foreground">
          <span className="truncate">{state}</span>
        </span>
      ) : (
        <button
          ref={foldRef}
          type="button"
          className="group/queue-header flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={onToggle}
        >
          <span className="min-w-0 truncate">
            {pause && !expanded ? <span>{state} · </span> : null}
            <span className="font-medium text-foreground group-hover/queue-header:text-accent-foreground">
              {expanded ? state : hiddenCount}
            </span>
          </span>
          {expanded ? (
            <ChevronUp className="size-3 shrink-0" aria-hidden />
          ) : (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          )}
          {attentionCaption ? (
            <span className="flex min-w-0 items-center gap-1 text-destructive">
              <AlertCircle className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{attentionCaption}</span>
            </span>
          ) : null}
        </button>
      )}
      {pause ? (
        <>
          {/* Each greys during the other: a Resume would send the cards a Clear is deleting. */}
          {count > 0 ? (
            <Button
              type="button"
              variant="chat-tool"
              size="xs"
              disabled={!clearCapable || queuePending !== null}
              onClick={onClearAll}
            >
              <NativeChatPendingIcon pending={queuePending === 'clear'} className="size-3">
                <Trash2 className="size-3" />
              </NativeChatPendingIcon>
              {t('components.native-chat.queuedMessages.clearAll', 'Clear all')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="default"
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
    </div>
  )
}
