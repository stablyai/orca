import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import { watchStructuredReviewReplySettled } from '@/lib/structured-agent-session-review-reply-settled'
import {
  checksPanelReviewStableKey,
  type PendingPRCommentAiAck
} from '../pr-comments-ai-launch-ack'
import type { SourceControlAgentLaunched } from '../runSourceControlAgentActionStart'
import type { ChecksPanelReview } from '../checks-panel-review'

/**
 * Refetches the PR once a structured chat says its host wrote the review reply it was handed: the
 * host may be a paired server, whose own mutation notice never reaches this client. Each watch
 * keeps the chat's read open while armed (owed work does, so a hidden chat still hears it) and
 * dies once run, with the panel, when the chat closes, or after the reply's window.
 */
export function useChecksPanelReviewReplyRefetch(args: {
  asyncResultKeyRef: RefObject<string>
  refreshCommentsAfterBulkResolve: (provider: ChecksPanelReview['provider']) => Promise<void>
}): (
  chat: NonNullable<SourceControlAgentLaunched['chat']>,
  resolution: PendingPRCommentAiAck
) => void {
  const { asyncResultKeyRef, refreshCommentsAfterBulkResolve } = args
  const watches = useRef(new Set<() => void>())
  const refreshLatest = useRef(refreshCommentsAfterBulkResolve)
  useEffect(() => {
    refreshLatest.current = refreshCommentsAfterBulkResolve
  }, [refreshCommentsAfterBulkResolve])
  useEffect(() => {
    const armed = watches.current
    return () => {
      for (const dispose of armed) {
        dispose()
      }
      armed.clear()
    }
  }, [])
  return useCallback(
    (chat, resolution) => {
      const provider = resolution.provider
      const launchKey = checksPanelReviewStableKey(resolution.reviewContextKey)
      const dispose = watchStructuredReviewReplySettled(
        chat.sessionId,
        () => {
          watches.current.delete(dispose)
          // Possibly hours later: only the review the panel shows now, with its fetch of now.
          if (checksPanelReviewStableKey(asyncResultKeyRef.current) === launchKey) {
            void refreshLatest.current(provider)
          }
        },
        {
          holdRead: () => getStructuredAgentSessionReadOwner(chat.sessionId, chat.target).activate()
        }
      )
      watches.current.add(dispose)
    },
    [asyncResultKeyRef]
  )
}
