import { NativeChatQueueHeader } from './NativeChatQueueHeader'
import { NativeChatQueuedMessageRows } from './NativeChatQueuedMessageRows'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  NativeChatQueuedMessageCard,
  queuedMessageCardCaption
} from './NativeChatQueuedMessageCard'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'
import type { AgentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { NATIVE_CHAT_ROOT_SELECTOR } from '@/components/native-chat/paste/native-chat-paste-request'
import { focusNativeChatPromptCard } from '../prompts/use-native-chat-prompt-card-focus'
import {
  headSteerableQueuedMessageCard,
  queuedMessageCardNeedsAttention
} from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import type { QueuedEditAttachTarget } from './editing/NativeChatQueuedMessageComposer'
import { NativeChatWorkerFailureStatus } from './NativeChatWorkerFailureStatus'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { openProviderAccountSettings } from '@/components/provider-accounts/open-provider-account-settings'

/** Keep host-held drafts outside the transcript until consumed; keep the live region mounted for the first card. */
export function NativeChatQueuedMessageList({
  controller,
  chatWorktreeId,
  agentName,
  statedFailures,
  steerHeld = false,
  focusComposer,
  editAttachTo,
  onSignIn,
  target
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
  onSignIn?: () => void
  target?: RuntimeClientTarget
}): React.JSX.Element {
  const t = useTranslate()
  const regionRef = useRef<HTMLDivElement>(null)
  const queueRef = useRef<HTMLDivElement>(null)
  const { cards, pause } = controller
  const accountProvider = pause?.delivery?.provider ?? editAttachTo?.agent
  const listId = useId()
  const [expanded, setExpanded] = useState(true)
  // Collapsing is local to this queue's run: once it empties, the next card shows open.
  if (cards.length === 0 && !expanded) {
    setExpanded(true)
  }
  const newest = cards.at(-1)
  const steerableHead = controller.queueCapable ? headSteerableQueuedMessageCard(cards) : null
  const attentionCard = !expanded ? cards.find(queuedMessageCardNeedsAttention) : undefined
  const attentionCaption = attentionCard
    ? queuedMessageCardCaption(attentionCard, agentName, statedFailures, t)
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
      {pause?.delivery ? (
        <div className="mx-auto w-full max-w-(--chat-content-max-width) px-4">
          <NativeChatWorkerFailureStatus
            delivery={{
              ...pause.delivery,
              provider: pause.delivery.provider ?? editAttachTo?.agent
            }}
            target={target}
            workerName={pause.delivery.workerName ?? agentName ?? 'Worker'}
            pending={controller.queuePending !== null}
            onResume={() => refocusAfter(controller.resume())}
            onSignIn={
              onSignIn ??
              (target && accountProvider
                ? () => openProviderAccountSettings(accountProvider, target)
                : (focusComposer ?? (() => undefined)))
            }
          />
        </div>
      ) : null}
      {cards.length === 0 && pause?.delivery && pause.delivery.waiting > 0 ? (
        <NativeChatQueueHeader
          count={pause.delivery.waiting}
          attentionCaption={null}
          pause={pause}
          queuePending={controller.queuePending}
          clearCapable={false}
          expanded={expanded}
          listId={listId}
          onClearAll={() => {}}
          onResume={() => refocusAfter(controller.resume())}
        />
      ) : null}
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
              aria-label={t('components.native-chat.queuedMessages.listLabel', 'Queued messages')}
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
                    showsSteerShortcut={card === steerableHead}
                    agentWorking={controller.isWorking}
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
