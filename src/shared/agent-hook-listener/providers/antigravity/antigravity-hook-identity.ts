import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import { readFirstString } from '../../interactive-tool'
import type { HookListenerState } from '../../listener-state'

export type AntigravityTranscriptOrigin = 'root' | 'child' | 'unknown'

export function classifyAntigravityTranscriptOrigin(origin: unknown): AntigravityTranscriptOrigin {
  if (!isRecord(origin)) {
    return 'unknown'
  }
  if (origin.source === 'USER_EXPLICIT' && origin.type === 'USER_INPUT') {
    return 'root'
  }
  if (origin.source === 'SYSTEM' && origin.type === 'SYSTEM_MESSAGE') {
    return 'child'
  }
  return 'unknown'
}

export function isAntigravityInSessionChildHook(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  origin: AntigravityTranscriptOrigin
): boolean {
  const rootConversationId = state.antigravityChildWorkByPaneKey.get(paneKey)?.rootConversationId
  const conversationId = readFirstString(hookPayload, ['conversationId', 'conversation_id'])
  if (!rootConversationId || !conversationId || conversationId === rootConversationId) {
    return false
  }
  return (
    origin === 'child' || (origin !== 'root' && !readFirstString(hookPayload, ['lastUserInput']))
  )
}
