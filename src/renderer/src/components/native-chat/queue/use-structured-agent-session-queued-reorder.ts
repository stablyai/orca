import { runWithFinally } from '@/lib/run-with-finally'
import { useCallback, useEffect } from 'react'
import { useNativeChatViewGuard } from '../pane/ownership/native-chat-view-memory'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentSessionQueuedMessageMoveResult } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { structuredAgentSessionHostKey } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import type { QueuedMessageCard } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import type { QueuedEditTransport } from './editing/native-chat-queued-edit-session'
import type { CaptureStructuredAgentSessionPresentation } from '../session/structured/writes/use-structured-agent-session-mutate'

export type QueuedMessageMoveAnchor =
  | { beforeMessageId: string | null; afterMessageId?: never }
  | { afterMessageId: string; beforeMessageId?: never }

export type QueuedMessageReorder = {
  scope: string
  pending: boolean
  move: (messageId: string, anchor: QueuedMessageMoveAnchor) => Promise<void>
}

/** `list` with `messageId` moved to its anchor, as the host moves it; null when either is gone. */
function movedQueue(
  list: QueuedMessageCard[],
  messageId: string,
  anchor: QueuedMessageMoveAnchor
): QueuedMessageCard[] | null {
  const movable = list.filter((card) => card.hold !== 'sending')
  const moving = movable.find((card) => card.messageId === messageId)
  const remaining = movable.filter((card) => card !== moving)
  const anchorId = anchor.afterMessageId ?? anchor.beforeMessageId
  const at =
    anchorId == null ? remaining.length : remaining.findIndex((card) => card.messageId === anchorId)
  if (!moving || at < 0) {
    return null
  }
  remaining.splice(at + (anchor.afterMessageId ? 1 : 0), 0, moving)
  const movableSet = new Set(movable)
  let nextMovable = 0
  return list.map((card) => (movableSet.has(card) ? (remaining[nextMovable++] ?? card) : card))
}

function sameOrder(a: readonly QueuedMessageCard[], b: readonly QueuedMessageCard[]): boolean {
  return a.length === b.length && a.every((card, index) => card.messageId === b[index]?.messageId)
}

/** The fresh cards in the previewed order: a republish that keeps the order still shows its text and holds. */
function inOrderOf(
  order: readonly QueuedMessageCard[],
  fresh: QueuedMessageCard[]
): QueuedMessageCard[] {
  const byId = new Map(fresh.map((card) => [card.messageId, card]))
  return order.map((card) => byId.get(card.messageId) ?? card)
}

/** `cards` are the ones the person drags; `held` is every card the host holds, mail drawn in the
 *  transcript included, previewed with the same move so the queue's head stays right meanwhile. */
export function useStructuredAgentSessionQueuedReorder(
  cards: QueuedMessageCard[],
  held: QueuedMessageCard[],
  transport: QueuedEditTransport,
  capturePresentation: CaptureStructuredAgentSessionPresentation
): { cards: QueuedMessageCard[]; held: QueuedMessageCard[]; reorder?: QueuedMessageReorder } {
  const scope = `${structuredAgentSessionHostKey(transport.target)}:${transport.sessionId}`
  // Kept with the chat tab: a view released mid-move returns still guarded and still showing the move.
  const [pending, setPending, busy] = useNativeChatViewGuard(`queued-reorder:${scope}`, false)
  const [preview, setPreview] = useNativeChatViewGuard<{
    scope: string
    base: QueuedMessageCard[]
    cards: QueuedMessageCard[]
    heldBase: QueuedMessageCard[]
    held: QueuedMessageCard[]
  } | null>(`queued-reorder-preview:${scope}`, null)
  const move = useCallback(
    async (messageId: string, anchor: QueuedMessageMoveAnchor) => {
      if (busy() || !transport.reorderCapable) {
        return
      }
      const moved = movedQueue(cards, messageId, anchor)
      if (!moved) {
        return
      }
      const optimistic = {
        scope,
        base: cards,
        cards: moved,
        heldBase: held,
        held: movedQueue(held, messageId, anchor) ?? held
      }
      setPending(true)
      setPreview(optimistic)
      const isCurrent = capturePresentation()
      await runWithFinally(
        async () => {
          const result = await transport.write<AgentSessionQueuedMessageMoveResult>(
            'agentSession.queuedMessageMove',
            'agentSession.queuedMessageMove',
            { messageId, ...anchor }
          )
          if (
            result.kind !== 'done' ||
            (result.value.status !== 'moved' && result.value.status !== 'unchanged')
          ) {
            setPreview((current) => (current === optimistic ? null : current))
            if (isCurrent() && result.kind === 'not-done') {
              toast.error(result.notice)
            } else if (isCurrent() && result.kind === 'done') {
              toast.error(
                translate(
                  'components.native-chat.queuedMessages.moveChanged',
                  'The queue changed before this move. Try dragging the message again.'
                )
              )
            }
          }
        },
        () => setPending(false)
      )
    },
    [cards, held, capturePresentation, scope, transport, busy, setPending, setPreview]
  )
  // Any publication supersedes the preview, including another client's concurrent move. Compared by order, not
  // identity: a chat remounted mid-move rebuilds equal cards and still shows the move.
  const previewing =
    preview?.scope === scope && sameOrder(preview.base, cards) && sameOrder(preview.heldBase, held)
  // A superseded preview is dropped once no move waits on it, so a settled one keeps no old queue.
  const stale = preview !== null && !previewing && !pending
  useEffect(() => {
    if (stale) {
      setPreview(null)
    }
  }, [stale, setPreview])
  return {
    cards: previewing ? inOrderOf(preview.cards, cards) : cards,
    held: previewing ? inOrderOf(preview.held, held) : held,
    ...(transport.reorderCapable ? { reorder: { scope, pending, move } } : {})
  }
}
