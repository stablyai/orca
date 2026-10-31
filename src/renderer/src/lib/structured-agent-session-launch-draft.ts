import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { findStructuredLaunchTab } from './structured-agent-session-launch-surface'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import { promptTextContent } from '@/components/native-chat/native-chat-prompt-document-text'
import type { StructuredAgentLaunchOptions } from './structured-agent-session-launch-callers'
import type { StructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-registry'

export function seedStructuredAgentLaunchDraft(
  state: StructuredLaunchState,
  options: StructuredAgentLaunchOptions
): void {
  if (options.promptDelivery !== 'draft' || !options.prompt) {
    return
  }
  const { sessionId, worktreeId, executionHostId } = state.intent
  const scopeKey = structuredAgentSessionDraftScopeKey(sessionId)
  const current = readNativeChatComposerDraft(scopeKey)
  if (current.text !== '' || current.document) {
    return
  }
  const document = promptTextContent(options.prompt)
  updateNativeChatComposerDraft(
    scopeKey,
    { text: options.prompt, document, owner: { workspaceId: worktreeId, executionHostId } },
    'immediate',
    undefined,
    {
      at: 'end',
      target: findStructuredLaunchTab(state.intent)?.id ?? structuredAgentSessionTabId(sessionId),
      pending: true
    }
  )
}
