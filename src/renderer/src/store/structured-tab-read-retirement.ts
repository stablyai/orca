import type { AppState } from './types'
import { structuredReadOwnerKey } from '../components/native-chat/structured-agent-session-read-owner-registry'
import { structuredAgentSessionTargetForTab } from '../runtime/structured-agent-session-owner'
import { structuredChatTabs } from '../lib/structured-chat-tab-index'

export function removedStructuredReaders(previous: AppState, next: AppState) {
  if (previous.unifiedTabsByWorktree === next.unifiedTabsByWorktree) {
    return []
  }
  const readers = (state: AppState) =>
    structuredChatTabs(state.unifiedTabsByWorktree).flatMap((tab) => {
      const target = structuredAgentSessionTargetForTab(state, tab)
      return target ? [{ sessionId: tab.entityId, target }] : []
    })
  const remaining = new Set(
    readers(next).map(({ sessionId, target }) => structuredReadOwnerKey(sessionId, target))
  )
  return readers(previous).filter(
    ({ sessionId, target }) => !remaining.has(structuredReadOwnerKey(sessionId, target))
  )
}
