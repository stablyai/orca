// Fetch outlines only for visible panes with unloaded history and host support; key stale requests by epoch to avoid streaming churn, retry with backoff and fall back to loaded rows.

import { useEffect, useState } from 'react'
import type { AgentSessionConversationOutline } from '../../../../shared/agent-session/agent-session-conversation-outline'
import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import { agentSessionContextFloorSequence } from '../../../../shared/agent-session-context-clear'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { readStructuredAgentSessionConversationOutline } from '@/runtime/structured-agent-session-client'
import type { NativeChatRailOutlineEntry } from './native-chat-message-rail-items'
import { selectStructuredRailOutline } from './structured-agent-session-rail-outline'

export const RAIL_OUTLINE_READ_RETRIES = 3
export const RAIL_OUTLINE_READ_RETRY_BASE_MS = 2_000

export function useStructuredAgentSessionRailOutline({
  sessionId,
  target,
  state,
  contextFloor,
  enabled
}: {
  sessionId: string
  target: RuntimeClientTarget
  state: Pick<StructuredAgentSessionState, 'epoch' | 'items' | 'hasOlder'>
  /** The host's latest `/clear`; the transcript shows nothing before it, so neither does the rail. */
  contextFloor?: AgentJournalCursor
  enabled: boolean
}): readonly NativeChatRailOutlineEntry[] | null {
  const [outline, setOutline] = useState<AgentSessionConversationOutline | null>(null)
  const current = outline?.sessionId === sessionId ? outline : null
  const view = selectStructuredRailOutline(current, {
    epoch: state.epoch,
    oldestLoadedSequence: state.items[0]?.sequence ?? null,
    hasOlder: state.hasOlder,
    contextFloor: agentSessionContextFloorSequence(contextFloor, state.epoch)
  })
  const requestKey = enabled && view.kind === 'stale' ? `${sessionId}:${state.epoch}` : null
  const [retry, setRetry] = useState<{ key: string | null; attempt: number }>({
    key: null,
    attempt: 0
  })
  const attempt = retry.key === requestKey ? retry.attempt : 0

  useEffect(() => {
    if (requestKey === null) {
      return
    }
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    void readStructuredAgentSessionConversationOutline(target, sessionId).then(
      (result) => {
        if (!cancelled && result) {
          setOutline(result)
        }
      },
      () => {
        if (!cancelled && attempt < RAIL_OUTLINE_READ_RETRIES) {
          retryTimer = setTimeout(
            () => setRetry({ key: requestKey, attempt: attempt + 1 }),
            RAIL_OUTLINE_READ_RETRY_BASE_MS * 2 ** attempt
          )
        }
      }
    )
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
    }
  }, [attempt, requestKey, sessionId, target])

  return view.kind === 'fresh' ? view.entries : null
}
