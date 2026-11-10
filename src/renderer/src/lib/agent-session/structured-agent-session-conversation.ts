import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import { readStructuredChatTabSavedName } from '@/runtime/structured-chat-tab-name'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { nativeChatComposerHasUserContent } from '@/components/native-chat/native-chat-pending-attachment-cache'
import { findStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'

export function hasStructuredAgentSessionConversation(tab: Tab, state: AppState): boolean {
  if (tab.customLabel?.trim() || tab.aiVaultTitle != null) {
    return true
  }
  if (readStructuredChatTabSavedName(tab, state) !== null) {
    return true
  }
  const scopeKey = structuredAgentSessionDraftScopeKey(tab.entityId)
  if (nativeChatComposerHasUserContent(scopeKey)) {
    return true
  }
  const target = structuredAgentSessionTargetForHost(tab.executionHostId)
  const owner = findStructuredAgentSessionReadOwner(tab.entityId, target, tab.executionHostId ?? '')
  if (owner && owner.getSnapshot().state.items.length > 0) {
    return true
  }
  return false
}
