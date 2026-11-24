import { useCallback, useRef, useState } from 'react'
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

/** `cards` are the ones the person drags; `held` is every card the host holds, mail drawn in the
 *  transcript included, previewed with the same move so the queue's head stays right meanwhile. */
export function useStructuredAgentSessionQueuedReorder(
  cards: QueuedMessageCard[],
  held: QueuedMessageCard[],
  transport: QueuedEditTransport,
  capturePresentation: CaptureStructuredAgentSessionPresentation
): { cards: QueuedMessageCard[]; held: QueuedMessageCard[]; reorder?: QueuedMessageReorder } {
  const scope = `${structuredAgentSessionHostKey(transport.target)}:${transport.sessionId}`
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [preview, setPreview] = useState<{
    scope: string
    base: QueuedMessageCard[]
    cards: QueuedMessageCard[]
    heldBase: QueuedMessageCard[]
    held: QueuedMessageCard[]
  } | null>(null)
  const move = useCallback(
    async (messageId: string, anchor: QueuedMessageMoveAnchor) => {
      if (busy.current || !transport.reorderCapable) {
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
      busy.current = true
      setPending(true)
      setPreview(optimistic)
      const isCurrent = capturePresentation()
      try {
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
      } finally {
        busy.current = false
        setPending(false)
      }
    },
    [cards, held, capturePresentation, scope, transport]
  )
  // Any publication supersedes the preview, including another client's concurrent move.
  const previewing = preview?.scope === scope && preview.base === cards && preview.heldBase === held
  return {
    cards: previewing ? preview.cards : cards,
    held: previewing ? preview.held : held,
    ...(transport.reorderCapable ? { reorder: { scope, pending, move } } : {})
  }
}
