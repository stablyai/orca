import type { AgentJournalRenderItem } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentProviderSessionMetadata } from '../../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryResult
} from '../../../../../../../shared/agent-session/agent-session-wire'
import {
  oldestStructuredAgentSessionCursor,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../../../../../shared/agent-session/structured-agent-session-reducer'
import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { NATIVE_CHAT_INITIAL_LIMIT } from '../../../viewport/history/native-chat-pagination'
import { OLDER_PAGE_ANCHOR_ATTEMPTS } from './structured-agent-session-older-page-read'

function countsTowardInitialHistory(item: AgentJournalRenderItem): boolean {
  return item.body.kind !== 'status' || !item.body.providerFrame
}

export function createStructuredAgentSessionReadHydrate({
  target,
  sessionId,
  getState,
  apply,
  setProviderSession
}: {
  target: RuntimeClientTarget | null
  sessionId: string
  getState: () => StructuredAgentSessionState
  apply: (action: StructuredAgentSessionAction) => void
  setProviderSession: (providerSession: AgentProviderSessionMetadata | undefined) => void
}) {
  return async (shouldStop: () => boolean): Promise<void> => {
    if (!target) {
      return
    }
    const result = await callStructuredAgentSession<AgentSessionHistoryResult>(
      target,
      'agentSession.history',
      { sessionId, direction: 'tail', limit: AGENT_SESSION_HISTORY_MAX_LIMIT }
    )
    if (shouldStop()) {
      return
    }
    setProviderSession(result.providerSession)
    if (!result.ok) {
      if (shouldStop()) {
        return
      }
      apply({
        type: 'event',
        event: {
          type: 'reset',
          sessionId,
          reset: result.reset,
          page: result.page,
          fence: result.fence ?? 0
        }
      })
      return
    }
    if (shouldStop()) {
      return
    }
    apply({ type: 'history-page', page: result.page })
    if (shouldStop()) {
      return
    }
    let restored = getState().items.filter(countsTowardInitialHistory).length
    let anchorSlides = 0
    while (getState().hasOlder && restored < NATIVE_CHAT_INITIAL_LIMIT) {
      const oldest = oldestStructuredAgentSessionCursor(getState())
      if (!oldest || shouldStop()) {
        break
      }
      const missing = NATIVE_CHAT_INITIAL_LIMIT - restored
      const older = await callStructuredAgentSession<AgentSessionHistoryResult>(
        target,
        'agentSession.history',
        {
          sessionId,
          direction: 'before',
          cursor: oldest,
          limit: Math.min(AGENT_SESSION_HISTORY_MAX_LIMIT, missing)
        }
      )
      if (shouldStop()) {
        return
      }
      if (!older.ok || older.page.window.oldest?.sequence === oldest.sequence) {
        break
      }
      if (shouldStop()) {
        return
      }
      // Bound re-anchoring when head trimming makes older pages discontiguous.
      if (oldestStructuredAgentSessionCursor(getState())?.sequence !== oldest.sequence) {
        anchorSlides += 1
        if (anchorSlides >= OLDER_PAGE_ANCHOR_ATTEMPTS) {
          break
        }
        continue
      }
      apply({ type: 'older-page', requestedCursor: oldest, page: older.page })
      if (shouldStop()) {
        return
      }
      restored = getState().items.filter(countsTowardInitialHistory).length
    }
  }
}
