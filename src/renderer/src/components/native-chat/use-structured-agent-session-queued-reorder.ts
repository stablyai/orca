import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentSessionQueuedMessageMoveResult } from '../../../../shared/agent-session-wire'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import type { QueuedMessageCard } from '../../../../shared/structured-agent-session-queued-cards'
import type { QueuedEditTransport } from './use-structured-agent-session-queued-edit'
import type { CaptureStructuredAgentSessionPresentation } from './use-structured-agent-session-mutate'

export type QueuedMessageMoveAnchor =
  | { beforeMessageId: string | null; afterMessageId?: never }
  | { afterMessageId: string; beforeMessageId?: never }

export type QueuedMessageReorder = {
  scope: string
  pending: boolean
  move: (messageId: string, anchor: QueuedMessageMoveAnchor) => Promise<void>
}

export function useStructuredAgentSessionQueuedReorder(
  cards: QueuedMessageCard[],
  transport: QueuedEditTransport,
  capturePresentation: CaptureStructuredAgentSessionPresentation
): { cards: QueuedMessageCard[]; reorder?: QueuedMessageReorder } {
  const scope = `${structuredAgentSessionHostKey(transport.target)}:${transport.sessionId}`
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [preview, setPreview] = useState<{
    scope: string
    base: QueuedMessageCard[]
    cards: QueuedMessageCard[]
  } | null>(null)
  const move = useCallback(
    async (messageId: string, anchor: QueuedMessageMoveAnchor) => {
      if (busy.current || !transport.reorderCapable) {
        return
      }
      const movable = cards.filter((card) => card.hold !== 'sending')
      const moving = movable.find((card) => card.messageId === messageId)
      const remaining = movable.filter((card) => card !== moving)
      const anchorId = anchor.afterMessageId ?? anchor.beforeMessageId
      const at =
        anchorId == null
          ? remaining.length
          : remaining.findIndex((card) => card.messageId === anchorId)
      if (!moving || at < 0) {
        return
      }
      remaining.splice(at + (anchor.afterMessageId ? 1 : 0), 0, moving)
      const movableSet = new Set(movable)
      let nextMovable = 0
      const optimistic = {
        scope,
        base: cards,
        cards: cards.map((card) =>
          movableSet.has(card) ? (remaining[nextMovable++] ?? card) : card
        )
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
    [cards, capturePresentation, scope, transport]
  )
  return {
    // Any publication supersedes the preview, including another client's concurrent move.
    cards: preview?.scope === scope && preview.base === cards ? preview.cards : cards,
    ...(transport.reorderCapable ? { reorder: { scope, pending, move } } : {})
  }
}
