import { NativeChatQueuedMessageRows } from './NativeChatQueuedMessageRows'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  NativeChatQueuedMessageCard,
  queuedMessageCardCaption
} from './NativeChatQueuedMessageCard'
import { NativeChatQueueHeader } from './NativeChatQueueHeader'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'
import type { AgentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { NATIVE_CHAT_ROOT_SELECTOR } from '@/components/native-chat/paste/native-chat-paste-request'
import { focusNativeChatPromptCard } from '../prompts/use-native-chat-prompt-card-focus'
import {
  headSteerableQueuedMessageCard,
  queuedMessageCardNeedsAttention
} from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import type { QueuedEditAttachTarget } from './editing/NativeChatQueuedMessageComposer'
import { invalidateNativeChatDockFit } from '../pane/dock/native-chat-dock-fit'
import { useNativeChatDockFitToken } from '../pane/dock/use-native-chat-dock-fit'
import { NATIVE_CHAT_QUEUE_FULL_ROWS, useNativeChatQueueRoom } from './use-native-chat-queue-room'

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
  const t = useTranslate()
  const regionRef = useRef<HTMLDivElement>(null)
  const queueRef = useRef<HTMLDivElement>(null)
  const foldRef = useRef<HTMLButtonElement>(null)
  const unitRef = useRef<HTMLSpanElement>(null)
  const { cards, pause } = controller
  const listId = useId()
  const [expanded, setExpanded] = useState(true)
  // The person unfolded a queue the dock had folded for room; that choice wins until the queue empties.
  const [userOpen, setUserOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())
  const [dragging, setDragging] = useState(false)
  // A row holding focus keeps the list from folding for room; the header's own controls do not.
  const [listFocused, setListFocused] = useState(false)
  // Collapsing is local to this queue's run: once it empties, the next card shows open.
  if (cards.length === 0 && (!expanded || userOpen || showAll)) {
    setExpanded(true)
    setUserOpen(false)
    setShowAll(false)
  }
  const room = useNativeChatQueueRoom(regionRef, unitRef)
  // Expansion lasts while the list is capped below full (a question or a short pane), not past it.
  if (room.rowCap >= NATIVE_CHAT_QUEUE_FULL_ROWS && showAll) {
    setShowAll(false)
  }
  const editing = controller.editor !== undefined
  const shownOpenIds = cards.filter((card) => openIds.has(card.messageId))
  const fitFolded =
    useNativeChatDockFitToken(regionRef, 'queue') && !userOpen && !editing && !listFocused
  const listShown = expanded && !fitFolded
  // Rows are whole: the list's cap is a row count in the chat's own spacing, never a pixel total.
  const rowCap =
    editing || shownOpenIds.length > 0 ? null : showAll ? NATIVE_CHAT_QUEUE_FULL_ROWS : room.rowCap
  const hiddenCount = rowCap === null ? 0 : Math.max(0, cards.length - rowCap)
  const offersMore = room.rowCap < NATIVE_CHAT_QUEUE_FULL_ROWS && (showAll || hiddenCount > 0)
  const newest = cards.at(-1)
  const steerableHead = controller.queueCapable ? headSteerableQueuedMessageCard(cards) : null
  const attentionCard = !listShown ? cards.find(queuedMessageCardNeedsAttention) : undefined
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
  // A folded list has no box to observe, so its changes ask the dock to re-fit.
  useLayoutEffect(() => {
    if (regionRef.current) {
      invalidateNativeChatDockFit(regionRef.current)
    }
  }, [cards.length, editing, shownOpenIds.length, userOpen, showAll, expanded])
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
  const toggle = (): void => {
    if (fitFolded) {
      setUserOpen(true)
      return
    }
    // Folding hides the focused row; keep focus on the control that folded it.
    if (expanded && listRef.current?.contains(document.activeElement)) {
      foldRef.current?.focus()
    }
    setExpanded(!expanded)
  }
  return (
    <div
      ref={regionRef}
      aria-live="polite"
      data-native-chat-queue=""
      data-user-open={userOpen || undefined}
      data-editing={editing || undefined}
      data-list-focus={listFocused || undefined}
      className={cn(
        cards.length > 0 &&
          // A tab tucked 12px behind the next input surface or message box (its 8px top padding plus 12px).
          'relative z-0 flex min-h-0 shrink-0 flex-col px-3 sm:px-4 [[data-native-chat-composer-tab-strip]+&]:pt-2 [&:has(+:is([data-native-chat-queue-dock],[data-native-chat-composer-scope]))]:-mb-5 [[data-native-chat-dock-fit~=queue]_&[data-user-open]]:shrink'
      )}
    >
      {/* One chat-spacing unit, measured so row caps and the short-pane test scale with the chat's text size. */}
      <span ref={unitRef} aria-hidden className="pointer-events-none absolute h-1 w-0" />
      {cards.length > 0 ? (
        <div className="@container mx-auto flex min-h-0 w-full max-w-(--chat-content-max-width) flex-col">
          <div
            ref={queueRef}
            className="mx-3 flex min-h-0 flex-col rounded-t-xl border border-b-0 border-border bg-chat-composer-surface pt-0.5 pb-3.5 [--queued-row:calc(var(--spacing)*8)] [[data-native-chat-queue]:not(:has(+:is([data-native-chat-queue-dock],[data-native-chat-composer-scope])))_&]:mb-2 [[data-native-chat-queue]:not(:has(+:is([data-native-chat-queue-dock],[data-native-chat-composer-scope])))_&]:rounded-b-xl [[data-native-chat-queue]:not(:has(+:is([data-native-chat-queue-dock],[data-native-chat-composer-scope])))_&]:border-b [[data-native-chat-queue]:not(:has(+:is([data-native-chat-queue-dock],[data-native-chat-composer-scope])))_&]:pb-1"
          >
            <NativeChatQueueHeader
              foldRef={foldRef}
              count={cards.length}
              attentionCaption={attentionCaption}
              pause={pause}
              queuePending={controller.queuePending}
              clearCapable={controller.clearCapable}
              expanded={listShown}
              foldDisabled={dragging}
              listId={listId}
              onToggle={toggle}
              onClearAll={() => refocusAfter(controller.clear())}
              onResume={() => refocusAfter(controller.resume())}
            />
            <ul
              ref={listRef}
              id={listId}
              onFocus={() => setListFocused(true)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setListFocused(false)
                }
              }}
              // Hidden, not unmounted: an open edit keeps its typing while the list is collapsed.
              hidden={!expanded}
              aria-label={t('components.native-chat.queuedMessages.listLabel', 'Queued messages')}
              style={
                rowCap === null
                  ? undefined
                  : { maxHeight: `calc(var(--queued-row) * ${rowCap} + var(--spacing) * 0.5)` }
              }
              className={cn(
                'scrollbar-sleek min-h-(--queued-row) shrink overflow-y-auto px-1 py-px',
                rowCap === null && 'max-h-72',
                // Folded for room unless the person opened it, is editing, or has focus in it.
                '[[data-native-chat-dock-fit~=queue]_[data-native-chat-queue]:not([data-user-open],[data-editing],[data-list-focus])_&]:hidden'
              )}
            >
              <NativeChatQueuedMessageRows
                cards={cards}
                reorder={controller.editor ? undefined : controller.reorder}
                onDraggingChange={setDragging}
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
                    expanded={openIds.has(card.messageId)}
                    onToggleExpanded={() =>
                      setOpenIds((ids) => {
                        const next = new Set(ids)
                        if (!next.delete(card.messageId)) {
                          next.add(card.messageId)
                        }
                        return next
                      })
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
            {offersMore && expanded ? (
              <button
                type="button"
                aria-controls={listId}
                aria-expanded={showAll}
                onClick={() => setShowAll(!showAll)}
                className="mx-1 shrink-0 rounded-md px-1.5 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline-[1.5px] focus-visible:outline-foreground/45 [[data-native-chat-dock-fit~=queue]_[data-native-chat-queue]:not([data-user-open],[data-editing],[data-list-focus])_&]:hidden"
              >
                {showAll
                  ? t('components.native-chat.queuedMessages.showLessRows', 'Show less')
                  : t('components.native-chat.queuedMessages.moreRows', '+{{value0}} more', {
                      value0: hiddenCount
                    })}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
