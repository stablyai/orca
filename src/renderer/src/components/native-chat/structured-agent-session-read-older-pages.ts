// A chat's older history, one page at a time behind the live window: concurrent asks share one
// page, and a page whose anchor a live batch slid past is read again rather than leave a hole.

import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryResult
} from '../../../../shared/agent-session-wire'
import {
  oldestStructuredAgentSessionCursor,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

/** Bounded so a busy stream cannot turn one scroll-to-top into an endless read chain. */
export const OLDER_PAGE_ANCHOR_ATTEMPTS = 3

export function createStructuredAgentSessionOlderPageReader(args: {
  sessionId: string
  target: RuntimeClientTarget
  getState: () => StructuredAgentSessionState
  apply: (action: StructuredAgentSessionAction) => void
  /** The live read's guard: a page read under one that has since stopped is superseded. */
  captureHistoryReadGuard: () => () => boolean
  markLoadingOlder: () => void
  clearLoadingOlder: () => void
}): { loadOlder: () => Promise<NativeChatOlderPageResult> } {
  let olderPage: { shouldStop: () => boolean; promise: Promise<NativeChatOlderPageResult> } | null =
    null
  const readOlderPage = async (shouldStop: () => boolean): Promise<NativeChatOlderPageResult> => {
    try {
      // A live batch can head-trim past the anchor mid-read, and the reducer drops
      // that page rather than leave a hole in the transcript. Re-anchor and retry.
      for (let attempt = 0; attempt < OLDER_PAGE_ANCHOR_ATTEMPTS; attempt += 1) {
        const cursor = oldestStructuredAgentSessionCursor(args.getState())
        if (shouldStop()) {
          return 'superseded'
        }
        if (!cursor) {
          return 'exhausted'
        }
        const result = await callStructuredAgentSession<AgentSessionHistoryResult>(
          args.target,
          'agentSession.history',
          {
            sessionId: args.sessionId,
            direction: 'before',
            cursor,
            limit: AGENT_SESSION_HISTORY_MAX_LIMIT
          }
        )
        if (shouldStop()) {
          return 'superseded'
        }
        if (!result.ok) {
          return 'failed'
        }
        // The reducer drops a page whose anchor slid, so only an intact anchor lands.
        if (oldestStructuredAgentSessionCursor(args.getState())?.sequence === cursor.sequence) {
          args.apply({ type: 'older-page', requestedCursor: cursor, page: result.page })
          if (oldestStructuredAgentSessionCursor(args.getState())?.sequence !== cursor.sequence) {
            return 'applied'
          }
          return args.getState().hasOlder ? 'unchanged' : 'exhausted'
        }
      }
      return 'unchanged'
    } catch {
      // A failed page leaves the loaded conversation intact; the list offers a retry, and
      // the next invalidation (re-attach, snapshot, reset) re-enables paging.
      return shouldStop() ? 'superseded' : 'failed'
    }
  }

  const loadOlder = (): Promise<NativeChatOlderPageResult> => {
    // Concurrent callers (scroll-to-top, the button, a rail jump) share one page
    // and its result rather than reading a refusal as "no progress".
    if (olderPage && !olderPage.shouldStop()) {
      return olderPage.promise
    }
    const shouldStop = args.captureHistoryReadGuard()
    if (shouldStop()) {
      return Promise.resolve('superseded')
    }
    if (!oldestStructuredAgentSessionCursor(args.getState()) || !args.getState().hasOlder) {
      return Promise.resolve('exhausted')
    }
    args.markLoadingOlder()
    const page = { shouldStop, promise: readOlderPage(shouldStop) }
    olderPage = page
    void page.promise.finally(() => {
      if (olderPage !== page) {
        return
      }
      olderPage = null
      if (!shouldStop()) {
        args.clearLoadingOlder()
      }
    })
    return page.promise
  }
  return { loadOlder }
}
