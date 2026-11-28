import { toast } from 'sonner'
import { ownBotHost } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useNativeChatViewState } from '../pane/ownership/native-chat-view-memory'
import type { PairedServerAskCard } from '../../../../../shared/rpc-contract/paired-server-asks-params'

export type PairedServerAskDecision = 'once' | 'always' | 'deny'

const NONE_SUBMITTING: ReadonlyMap<string, PairedServerAskDecision> = new Map()

/** Decisions still being sent, kept with the chat tab: a chat released mid-answer returns with its buttons held. */
export function usePairedServerAskDecisions(): {
  submitting: ReadonlyMap<string, PairedServerAskDecision>
  decide: (card: PairedServerAskCard, decision: PairedServerAskDecision) => void
} {
  const [submitting, setSubmitting] = useNativeChatViewState(
    'paired-asks-submitting',
    NONE_SUBMITTING
  )
  const decide = (card: PairedServerAskCard, decision: PairedServerAskDecision): void => {
    setSubmitting((current) => new Map(current).set(card.messageId, decision))
    // On this computer's own Orca, which holds the card; the list drops it once answered anywhere.
    callRuntimeRpc(ownBotHost().target, 'pairedServerAsks.decide', {
      messageId: card.messageId,
      decision
    })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error))
      )
      .finally(() =>
        setSubmitting((current) => {
          const next = new Map(current)
          next.delete(card.messageId)
          return next.size === 0 ? NONE_SUBMITTING : next
        })
      )
  }
  return { submitting, decide }
}
