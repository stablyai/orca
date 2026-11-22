import { useEffect, useReducer } from 'react'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import type { BotRef } from '@/lib/bot-hosts'
import { callBotGroupRpc } from '@/lib/bot-group-rpc'
import {
  reduceBotGroupTranscript,
  type BotGroupTranscript
} from '../../../../shared/bots/bot-group-transcript'

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

/** The room's transcript while visible: re-read on every host bots change, older pages on request.
 *  A thread's room is read when `threadId` is set. */
export function useBotGroupTranscript(
  group: BotRef | undefined,
  threadId: string | undefined,
  isVisible: boolean,
  setError: (message: string | null) => void
) {
  const [data, apply] = useReducer(reduceBotGroupTranscript, null)
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
          }
        })
        .catch((error: unknown) => !closed && setError(String(error)))
    }
    read()
    const stopListening = onBotsChanged(read, hostId, { kinds: ['groups'] })
    return () => {
      closed = true
      stopListening()
    }
  }, [apply, groupId, hostId, threadId, isVisible, setError])
  const loadEarlier = () => {
    if (data?.hasEarlier) {
      void readPage(data.group, threadId, data.messages[0]?.sequence)
        .then((page) => apply({ kind: 'earlier', page }))
        .catch((error: unknown) => setError(String(error)))
    }
  }
  return { data, apply, loadEarlier }
}
