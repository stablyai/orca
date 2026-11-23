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
  const listRef = useRef<HTMLUListElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const { cards, pause } = controller
  const listId = useId()
  const [expanded, setExpanded] = useState(true)
  // The person unfolded a queue the dock had folded for room; that choice wins until the queue empties.
  const [userOpen, setUserOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  // A row holding focus keeps the list from folding for room; the header's own controls do not.
  const [listFocused, setListFocused] = useState(false)
  // Collapsing is local to this queue's run: once it empties, the next card shows open.
  if (cards.length === 0 && (!expanded || userOpen || showAll)) {
    setExpanded(true)
    setUserOpen(false)
    setShowAll(false)
  }
  const focusBeforeCapping = (cap: number): void => {
    const list = listRef.current
    const active = list?.ownerDocument.activeElement
    if (
      list?.contains(active ?? null) &&
      Array.from(list.children)
        .slice(cap)
        .some((row) => row.contains(active ?? null))
    ) {
      ;(moreRef.current ?? foldRef.current)?.focus({ preventScroll: true })
    }
  }
  const editing = controller.editor !== undefined
  const rowCap = useNativeChatQueueRoom(regionRef, unitRef, (cap) => {
    if (!showAll && !editing) {
      focusBeforeCapping(cap)
    }
  })
  // Expansion lasts while the list is capped below full (a question or a short pane), not past it.
  if (rowCap >= NATIVE_CHAT_QUEUE_FULL_ROWS && showAll) {
    setShowAll(false)
  }
  const fitFolded =
    useNativeChatDockFitToken(regionRef, 'queue') && !userOpen && !editing && !listFocused
  const listShown = expanded && !fitFolded
  const hiddenCount = Math.max(0, cards.length - rowCap)
  const offersMore = !editing && rowCap < NATIVE_CHAT_QUEUE_FULL_ROWS && hiddenCount > 0
  const shownCards = offersMore && !showAll ? cards.slice(0, rowCap) : cards
  const newest = cards.at(-1)
  const steerableHead = controller.queueCapable ? headSteerableQueuedMessageCard(cards) : null
  // The first attention card that states a failure: an unconfirmed one has no caption and must not hide a later Retry.
  const attentionCaption = listShown
    ? null
    : (cards
        .filter(queuedMessageCardNeedsAttention)
        .map((card) => queuedMessageCardCaption(card, agentName, statedFailures, t))
        .find((caption) => caption !== null) ?? null)
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
  }, [cards.length, editing, rowCap, userOpen, showAll, expanded])
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
  // "+N more" goes away when the pane grows or the question closes; focus on it moves into the queue
  // rather than falling to the page. Only a blur from its removal keeps the claim.
  const moreHadFocus = useRef(false)
  useLayoutEffect(() => {
    const active = document.activeElement
    if (!moreHadFocus.current || moreRef.current || (active && active !== document.body)) {
      return
    }
    moreHadFocus.current = false
    const list = listRef.current
    const row = list?.querySelector('li')
    const firstRow =
      row?.querySelector<HTMLElement>('[data-queued-message-send]:not(:disabled)') ??
      row?.querySelector<HTMLElement>('button:not(:disabled)')
    // The first row if the list is showing, else the toggle that opens it.
    ;(listShown && firstRow ? firstRow : foldRef.current)?.focus()
  })
  const leaveList = (event: React.FocusEvent): void => {
    const next = event.relatedTarget
    const staysInList =
      next instanceof Node &&
      (listRef.current?.contains(next) === true || moreRef.current?.contains(next) === true)
    if (!staysInList) {
      setListFocused(false)
    }
  }
  const toggle = (): void => {
    if (fitFolded) {
      // A list the person folded before the dock did opens too, in one activation.
      setUserOpen(true)
      setExpanded(true)
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
      className="relative shrink-0"
    >
      {/* One chat-spacing unit, measured so row caps and the short-pane test scale with the chat's text size. */}
      <span ref={unitRef} aria-hidden className="pointer-events-none absolute h-1 w-0" />
      {cards.length > 0 ? (
        <div ref={queueRef} className="@container shrink-0 bg-chat-pane px-3 pt-2 sm:px-4">
          <div className="mx-auto w-full max-w-(--chat-content-max-width) rounded-lg border border-border bg-muted/50 text-xs text-muted-foreground shadow-xs">
            <NativeChatQueueHeader
              foldRef={foldRef}
              count={cards.length}
              attentionCaption={attentionCaption}
              pause={pause}
              queuePending={controller.queuePending}
              clearCapable={controller.clearCapable}
              expanded={listShown}
              listId={listId}
              onToggle={toggle}
              onClearAll={() => refocusAfter(controller.clear())}
              onResume={() => refocusAfter(controller.resume())}
            />
            <ul
              ref={listRef}
              id={listId}
              // A tap or click on a row's text focuses the row itself (to reveal its tools on touch); only a control holds the list open.
              onFocus={(event) => {
                setListFocused(!(event.target instanceof HTMLLIElement))
              }}
              onBlur={leaveList}
              // Hidden, not unmounted: an open edit keeps its typing while the list is collapsed.
              hidden={!expanded}
              aria-label={t('components.native-chat.queuedMessages.listLabel', 'Queued messages')}
              className={cn(
                'scrollbar-sleek overflow-y-auto px-1.5 pb-1.5',
                editing ? 'max-h-72' : 'max-h-40',
                // Folded for room unless the person opened it, is editing, or has focus in it.
                '[[data-native-chat-dock-fit~=queue]_[data-native-chat-queue]:not([data-user-open],[data-editing],[data-list-focus])_&]:hidden'
              )}
            >
              <NativeChatQueuedMessageRows
                cards={shownCards}
                allCards={cards}
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
            {offersMore && expanded ? (
              <button
                type="button"
                ref={moreRef}
                aria-controls={listId}
                aria-expanded={showAll}
                // Part of the list for focus: expanding must not let the dock fold it away under the toggle.
                onFocus={() => {
                  moreHadFocus.current = true
                  setListFocused(true)
                }}
                onBlur={(event) => {
                  const button = event.currentTarget
                  if (event.relatedTarget) {
                    moreHadFocus.current = false
                  } else {
                    // Focus left the window or went nowhere while the button stays: the claim ends
                    // (a return refocuses and claims again). Only the button's removal keeps it.
                    queueMicrotask(() => {
                      if (button.isConnected) {
                        moreHadFocus.current = false
                      }
                    })
                  }
                  leaveList(event)
                }}
                onClick={() => {
                  if (showAll) {
                    focusBeforeCapping(rowCap)
                  }
                  setShowAll(!showAll)
                }}
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
