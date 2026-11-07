import { useContext, useLayoutEffect, useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  NativeChatForkContext,
  NativeChatSideChatForkPointContext
} from './native-chat-fork-context'
import type {
  NativeChatSideChatForkOffer,
  NativeChatSideChatForkPoint
} from './native-chat-side-chat-fork-point'
import type { NativeChatForkSurface } from './use-native-chat-fork'

/** `/btw`: fork the chat through its newest finished response and ask there, beside the chat. */
export type NativeChatSideChat = {
  /** Why no side chat can start now. */
  notReadyReason: string | null
  /** Starts one; the reason when it can't start now, else whether it started (with a question:
   *  whether the question went out). */
  open: (question: string) => Promise<{ refused: string } | { started: boolean }>
  /** The transcript's newest response that offers Fork, as drawn. */
  reportForkPoint: (point: NativeChatSideChatForkPoint) => void
}

/** Undefined where Orca can't fork this chat, so `/btw` stays the agent's. */
export function useNativeChatSideChat(
  fork: NativeChatForkSurface | undefined
): NativeChatSideChat | undefined {
  // Nothing drawn yet means no response to fork through.
  const [point, reportForkPoint] = useState<NativeChatSideChatForkPoint>({ kind: 'no-reply' })
  return useMemo(() => {
    if (!fork) {
      return undefined
    }
    const start = (): { refused: string } | { throughItemId: string } => {
      if (fork.support.kind === 'unknown') {
        return {
          refused: translate(
            'components.native-chat.sideChat.notReady',
            'Side chats are not ready yet. Try again in a moment.'
          )
        }
      }
      // A rewind may have dropped the reported response before the list said so.
      return point.kind === 'ready' && fork.forkableItemIds.has(point.throughItemId)
        ? { throughItemId: point.throughItemId }
        : { refused: sideChatRefusal(point.kind === 'ready' ? { kind: 'no-reply' } : point) }
    }
    const now = start()
    return {
      notReadyReason: 'refused' in now ? now.refused : null,
      reportForkPoint,
      open: async (question) => {
        const next = start()
        if ('refused' in next) {
          return next
        }
        const outcome = await fork.request(next.throughItemId, question ? { question } : {})
        return { started: question ? outcome?.question === 'sent' : outcome?.chat !== undefined }
      }
    }
  }, [fork, point])
}

/** What the transcript needs to find the response `/btw` forks through; undefined where nothing
 *  listens, so it does no fork work at all. */
export function useNativeChatSideChatForkOffer(
  latestTurnKey: string | undefined
): NativeChatSideChatForkOffer | undefined {
  const fork = useContext(NativeChatForkContext)
  const listening = useContext(NativeChatSideChatForkPointContext) !== undefined
  const mode = fork?.support.kind === 'known' ? fork.support.fork : undefined
  const forkableItemIds = fork?.forkableItemIds
  const contextFloorSequence = fork?.contextFloorSequence
  return useMemo(
    () =>
      listening && mode && forkableItemIds && contextFloorSequence !== undefined
        ? {
            chat: { support: { kind: 'known', fork: mode }, contextFloorSequence, forkableItemIds },
            latestTurnKey
          }
        : undefined,
    [contextFloorSequence, forkableItemIds, latestTurnKey, listening, mode]
  )
}

/** Tells `/btw` where the drawn transcript offers Fork, each time that changes. */
export function useNativeChatSideChatForkPointReport(
  point: NativeChatSideChatForkPoint | null
): void {
  const report = useContext(NativeChatSideChatForkPointContext)
  const kind = point?.kind
  const throughItemId = point?.kind === 'ready' ? point.throughItemId : undefined
  useLayoutEffect(() => {
    if (kind === 'ready' && throughItemId) {
      report?.({ kind, throughItemId })
    } else if (kind === 'reply-running' || kind === 'no-reply') {
      report?.({ kind })
    }
  }, [kind, report, throughItemId])
  // An unmounted transcript (an empty conversation) has nothing to fork.
  useLayoutEffect(() => () => report?.({ kind: 'no-reply' }), [report])
}

function sideChatRefusal(point: Exclude<NativeChatSideChatForkPoint, { kind: 'ready' }>): string {
  if (point.kind === 'reply-running') {
    return translate(
      'components.native-chat.sideChat.replyRunning',
      'Available when this reply finishes.'
    )
  }
  return translate('components.native-chat.sideChat.noReply', 'Available after the first reply.')
}
