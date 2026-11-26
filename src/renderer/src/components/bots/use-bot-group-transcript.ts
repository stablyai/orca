import { useCallback, useEffect, useReducer, useState } from 'react'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import type { BotRef } from '@/lib/bot-hosts'
import { callBotGroupRpc } from '@/lib/bot-group-rpc'
import { botGroupRoomConcerned } from '../../../../shared/bots/bot-change-scope'
import {
  reduceBotGroupTranscript,
  type BotGroupTranscript
} from '../../../../shared/bots/bot-group-transcript'
import type { BotGroupReplyReveal } from './bot-group-reply-reveal'

function readPage(
  group: BotRef,
  threadId: string | undefined,
  beforeSequence?: number
): Promise<BotGroupTranscript> {
  return callBotGroupRpc(group, 'bots.groups.read', {
    groupId: group.id,
    threadId,
    beforeSequence
  })
}

/** The room's transcript while visible: re-read on each host groups change that names this room (or
 *  names none), older pages on request.
 *  A thread's room is read when `threadId` is set. */
export function useBotGroupTranscript(
  group: BotRef | undefined,
  threadId: string | undefined,
  isVisible: boolean,
  setError: (message: string | null) => void,
  replyReveal: BotGroupReplyReveal | null
) {
  const [data, apply] = useReducer(reduceBotGroupTranscript, null)
  const [readForReveal, setReadForReveal] = useState<BotGroupReplyReveal | null>(null)
  const groupId = group?.id
  const hostId = group?.hostId
  useEffect(() => {
    if (!groupId || !hostId || !isVisible) {
      return
    }
    const ref = { hostId, id: groupId }
    let closed = false
    let request = 0
    const read = () => {
      const current = ++request
      void readPage(ref, threadId)
        .then((page) => {
          if (!closed && request === current) {
            apply({ kind: 'recent', page })
            setError(null)
            setReadForReveal(replyReveal)
          }
        })
        .catch((error: unknown) => {
          if (!closed && request === current) {
            setError(String(error))
            setReadForReveal(replyReveal)
          }
        })
    }
    read()
    const stopListening = onBotsChanged(
      (_host, scope) => {
        if (botGroupRoomConcerned(scope, groupId)) {
          read()
        }
      },
      hostId,
      { kinds: ['groups'] }
    )
    return () => {
      closed = true
      stopListening()
    }
  }, [apply, groupId, hostId, threadId, isVisible, setError, replyReveal])
  const earlierSequence = data?.hasEarlier ? data.messages[0]?.sequence : undefined
  const loadEarlierPage = useCallback(
    async (signal?: AbortSignal) => {
      if (groupId && hostId && earlierSequence !== undefined) {
        const page = await readPage({ id: groupId, hostId }, threadId, earlierSequence)
        if (!signal?.aborted) {
          apply({ kind: 'earlier', page })
        }
      }
    },
    [groupId, hostId, threadId, earlierSequence]
  )
  const loadEarlier = () => {
    void loadEarlierPage().catch((error: unknown) => setError(String(error)))
  }
  return { data, apply, loadEarlier, loadEarlierPage, earlierSequence, readForReveal }
}
