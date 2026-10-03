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

export async function readStructuredAgentSessionOlderPage(args: {
  target: RuntimeClientTarget
  sessionId: string
  getState: () => StructuredAgentSessionState
  apply: (action: StructuredAgentSessionAction) => void
  shouldStop: () => boolean
}): Promise<NativeChatOlderPageResult> {
  const { target, sessionId, getState, apply, shouldStop } = args
  try {
    // A live batch can head-trim past the anchor mid-read, and the reducer drops
    // that page rather than leave a hole in the transcript. Re-anchor and retry.
    for (let attempt = 0; attempt < OLDER_PAGE_ANCHOR_ATTEMPTS; attempt += 1) {
      const cursor = oldestStructuredAgentSessionCursor(getState())
      if (shouldStop()) {
        return 'superseded'
      }
      if (!cursor) {
        return 'exhausted'
      }
      const result = await callStructuredAgentSession<AgentSessionHistoryResult>(
        target,
        'agentSession.history',
        { sessionId, direction: 'before', cursor, limit: AGENT_SESSION_HISTORY_MAX_LIMIT }
      )
      if (shouldStop()) {
        return 'superseded'
      }
      if (!result.ok) {
        return 'failed'
      }
      // The reducer drops a page whose anchor slid, so only an intact anchor lands.
      if (oldestStructuredAgentSessionCursor(getState())?.sequence === cursor.sequence) {
        apply({ type: 'older-page', requestedCursor: cursor, page: result.page })
        if (oldestStructuredAgentSessionCursor(getState())?.sequence !== cursor.sequence) {
          return 'applied'
        }
        return getState().hasOlder ? 'unchanged' : 'exhausted'
      }
    }
    return 'unchanged'
  } catch {
    // A failed page leaves the loaded conversation intact; the list offers a retry, and
    // the next invalidation (re-attach, snapshot, reset) re-enables paging.
    return shouldStop() ? 'superseded' : 'failed'
  }
}
