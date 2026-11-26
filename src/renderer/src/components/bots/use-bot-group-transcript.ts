import { useEffect, useEffectEvent, useReducer } from 'react'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import type { BotRef } from '@/lib/bot-hosts'
import { callBotGroupRpc } from '@/lib/bot-group-rpc'
import {
  botGroupChangedPosts,
  botGroupRoomConcerned
} from '../../../../shared/bots/bot-change-scope'
import {
  botGroupReplyBodies,
  drainBotGroupPostUpdates,
  pendingBotGroupPosts,
  reduceBotGroupTranscript,
  restoreBotGroupReplies,
  type BotGroupTranscript
} from '../../../../shared/bots/bot-group-transcript'

function readPage(
  group: BotRef,
  threadId: string | undefined,
  beforeSequence?: number,
  knownReplyKeys: readonly string[] = [],
  updatedPostIds?: readonly string[],
  updatesOnly?: true
): Promise<BotGroupTranscript> {
  return callBotGroupRpc(group, 'bots.groups.read', {
    groupId: group.id,
    threadId,
    beforeSequence,
    knownReplyKeys,
    updatedPostIds,
    updatesOnly
  })
}

/** The room's transcript while visible: re-read on each host groups change that names this room (or
 *  names none), older pages on request.
 *  A thread's room is read when `threadId` is set. */
export function useBotGroupTranscript(
  group: BotRef | undefined,
  threadId: string | undefined,
  isVisible: boolean,
  setError: (message: string | null) => void
) {
  const [data, apply] = useReducer(reduceBotGroupTranscript, null)
  const pendingPosts = useEffectEvent((id: string) => pendingBotGroupPosts(data, id))
  const groupId = group?.id
  const hostId = group?.hostId
  useEffect(() => {
    if (!groupId || !hostId || !isVisible) {
      return
    }
    const ref = { hostId, id: groupId }
    let closed = false
    let request = 0
    let replies: ReadonlyMap<string, string> = new Map()
    let updates: string[] = []
    const read = (changed: readonly string[] = pendingPosts(groupId)) => {
      updates = [...new Set([...updates, ...changed])]
      const current = ++request
      const held = replies
      const currentRead = () => !closed && request === current
      void readPage(ref, threadId, undefined, [...held.keys()].slice(-1_280), updates.slice(0, 40))
        .then(async (page) => {
          if (!closed && request === current) {
            const complete = restoreBotGroupReplies(page, held)
            replies = botGroupReplyBodies(complete)
            updates = [...(page.deferredPostIds ?? []), ...updates.slice(40)]
            apply({ kind: 'recent', page: complete })
            setError(null)
            await drainBotGroupPostUpdates(
              updates,
              (ids) => readPage(ref, threadId, undefined, [], ids, true),
              currentRead,
              (updated, remaining) => {
                updates = remaining
                apply({ kind: 'updated', page: updated })
              }
            )
          }
        })
        .catch((error: unknown) => !closed && setError(String(error)))
    }
    read()
    const stopListening = onBotsChanged(
      (_host, scope) => {
        if (botGroupRoomConcerned(scope, groupId)) {
          const changed = botGroupChangedPosts(scope, groupId, threadId)
          if (changed) {
            read(changed.recover ? [...changed.ids, ...pendingPosts(groupId)] : changed.ids)
          }
        }
      },
      hostId,
      { kinds: ['groups'], roomPosts: true }
    )
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
