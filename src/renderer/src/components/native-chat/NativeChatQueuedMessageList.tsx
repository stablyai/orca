import { NativeChatQueuedMessageRows } from './NativeChatQueuedMessageRows'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import {
  NativeChatQueuedMessageCard,
  queuedMessageCardCaption
} from './NativeChatQueuedMessageCard'
import type {
  QueuedMessagesPendingAction,
  StructuredAgentSessionQueuedMessagesController
} from './use-structured-agent-session-queued-messages'
import { NativeChatPendingIcon } from './NativeChatPendingIcon'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { NATIVE_CHAT_ROOT_SELECTOR } from '@/lib/native-chat-paste-request'
import { focusNativeChatPromptCard } from './use-native-chat-prompt-card-focus'
import { queuedMessageCardNeedsAttention } from '../../../../shared/structured-agent-session-queued-cards'
import type { QueuedEditAttachTarget } from './NativeChatQueuedMessageComposer'

/** Keep host-held drafts outside the transcript until consumed; keep the live region mounted for the first card. */
export function NativeChatQueuedMessageList({
  controller,
  chatWorktreeId,
  agentName,
  statedFailures,
  steerHeld = false,
  focusComposer,
  editAttachTo
}: {
  controller: StructuredAgentSessionQueuedMessagesController
  /** Where a card's sender is opened from; null shows it unlinked. */
  chatWorktreeId: string | null
  agentName?: string
  statedFailures?: readonly AgentSessionFailureFact[]
  /** The chat reads Stopping: no card steers into the turn a Stop is ending. */
  steerHeld?: boolean
  /** Where focus goes once Steer, Delete or a closing edit takes the focused card away. */
  focusComposer?: () => void
  /** The chat files added in a card's editor attach to, as its chat box attaches them. */
  editAttachTo?: QueuedEditAttachTarget
}): React.JSX.Element {
  const updateSettings = useAppStore((store) => store.updateSettings)
  const regionRef = useRef<HTMLDivElement>(null)
  const queueRef = useRef<HTMLDivElement>(null)
  const { cards, pause } = controller
  const listId = useId()
  const [expanded, setExpanded] = useState(true)
  // Collapsing is local to this queue's run: once it empties, the next card shows open.
  if (cards.length === 0 && !expanded) {
    setExpanded(true)
  }
  const newest = cards.at(-1)
  const attentionCard = !expanded ? cards.find(queuedMessageCardNeedsAttention) : undefined
  const attentionCaption = attentionCard
    ? queuedMessageCardCaption(attentionCard, agentName, statedFailures)
    : null
  const listRef = useRef<HTMLUListElement>(null)
  const newestIsPersons = newest !== undefined && !newest.from
  const shownIds = useRef<ReadonlySet<string> | null>(null)
  // Before paint, so the new card never shows a frame before the scroll.
  useLayoutEffect(() => {
    const appended =
      shownIds.current !== null &&
      shownIds.current.size > 0 &&
      newest !== undefined &&
      !shownIds.current.has(newest.messageId)
    shownIds.current = new Set(cards.map((card) => card.messageId))
    // The list opens on the next card to send; a card the person just queued is shown instead.
    if (appended && newestIsPersons && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [cards, newest, newestIsPersons])
  // Only a host that queues sends has queueing to turn off; a kept card shows without it.
  const turnOffQueueing = controller.queueCapable
    ? () => void updateSettings({ nativeChatQueueFollowUps: false })
    : undefined
  // Refocus only if focus stayed on the queue; an active prompt card takes priority over the composer.
  const refocusAfter = (action: Promise<unknown>): void => {
    void action.then(() => {
      const active = document.activeElement
      if (!active || active === document.body || queueRef.current?.contains(active)) {
        const root = regionRef.current?.closest(NATIVE_CHAT_ROOT_SELECTOR)
        if (!root || !focusNativeChatPromptCard(root, null)) {
          focusComposer?.()
        }
      }
    })
  }
  const editingId = controller.editor?.messageId
  const wasEditing = useRef(editingId)
  useEffect(() => {
    const closed = wasEditing.current !== undefined && editingId === undefined
    wasEditing.current = editingId
    if (closed) {
      refocusAfter(Promise.resolve())
    }
  })
  return (
    <div ref={regionRef} aria-live="polite">
      {cards.length > 0 ? (
        <div ref={queueRef} className="mx-auto w-full max-w-(--chat-content-max-width) px-4 py-1">
          <div className="divide-y divide-border rounded-md border border-border bg-card text-card-foreground">
            <NativeChatQueueHeader
              count={cards.length}
              attentionCaption={attentionCaption}
              pause={pause}
              queuePending={controller.queuePending}
              clearCapable={controller.clearCapable}
              expanded={expanded}
              listId={listId}
              onToggle={() => setExpanded(!expanded)}
              onClearAll={() => refocusAfter(controller.clear())}
              onResume={() => refocusAfter(controller.resume())}
            />
            <ul
              ref={listRef}
              id={listId}
              // Hidden, not unmounted: an open edit keeps its typing while the list is collapsed.
              hidden={!expanded}
              aria-label={translate(
                'components.native-chat.queuedMessages.listLabel',
                'Queued messages'
              )}
              // Bound queue height to preserve transcript/composer space; allow extra room for edit thumbnails.
              className={cn(
                'scrollbar-sleek divide-y divide-border overflow-y-auto',
                controller.editor ? 'max-h-72' : 'max-h-40'
              )}
            >
              <NativeChatQueuedMessageRows
                cards={cards}
                reorder={controller.editor ? undefined : controller.reorder}
                renderCard={(card, drag) => (
                  <NativeChatQueuedMessageCard
                    key={card.messageId}
                    card={card}
                    drag={drag}
                    chatWorktreeId={chatWorktreeId}
                    agentName={agentName}
                    statedFailures={statedFailures}
                    showsSteerShortcut={controller.queueCapable && card === newest}
                    steerHeld={steerHeld}
                    pending={controller.pending(card.messageId)}
                    onSteer={() => refocusAfter(controller.steer(card.messageId))}
                    onDelete={() => refocusAfter(controller.remove(card.messageId))}
                    onEdit={
                      controller.editCapable
                        ? () => void controller.edit(card.messageId)
                        : undefined
                    }
                    editor={
                      controller.editor?.messageId === card.messageId
                        ? controller.editor
                        : undefined
                    }
                    editAttachTo={editAttachTo}
                    editDisabled={controller.editor !== undefined}
                    onTurnOffQueueing={turnOffQueueing}
                  />
                )}
              />
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function NativeChatQueueHeader({
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
  pause: { reason: string } | null
  queuePending: QueuedMessagesPendingAction | null
  clearCapable: boolean
  expanded: boolean
  listId: string
  onToggle: () => void
  onClearAll: () => void
  onResume: () => void
}): React.JSX.Element {
  const toggleLabel = expanded
    ? translate('components.native-chat.queuedMessages.collapse', 'Collapse')
    : translate('components.native-chat.queuedMessages.expand', 'Expand')
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
          ? translate('components.native-chat.queuedMessages.paused', 'Paused')
          : translate('components.native-chat.queuedMessages.queued', 'Queued')}
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
            {translate('components.native-chat.queuedMessages.clearAll', 'Clear all')}
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
            {translate('components.native-chat.queuedMessages.resume', 'Resume')}
          </Button>
        </>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'components.native-chat.queuedMessages.listLabel',
              'Queued messages'
            )}
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
    </div>
  )
}
