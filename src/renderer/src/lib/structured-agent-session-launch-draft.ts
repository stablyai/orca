import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { findStructuredLaunchTab } from './structured-agent-session-launch-surface'
import {
  deleteNativeChatComposerDraft,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import type { NativeChatComposerDraftChange } from '@/components/native-chat/native-chat-composer-draft-store'
import { promptTextContent } from '@/components/native-chat/native-chat-prompt-document-text'
import type { StructuredAgentLaunchOptions } from './structured-agent-session-launch-callers'
import type { StructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-registry'

export function seedStructuredAgentLaunchDraft(
  state: StructuredLaunchState,
  options: StructuredAgentLaunchOptions
): void {
  if (options.draftFromScope) {
    const source = readNativeChatComposerDraft(options.draftFromScope)
    if (source.text !== '' || source.images.length > 0) {
      const { text, document, pastedTextFiles, images } = source
      seedEmptyLaunchDraft(state, {
        text,
        images,
        ...(document ? { document } : {}),
        ...(pastedTextFiles ? { pastedTextFiles } : {})
      })
    }
    deleteNativeChatComposerDraft(options.draftFromScope)
  }
  if (options.promptDelivery !== 'draft' || !options.prompt) {
    return
  }
  seedEmptyLaunchDraft(state, { text: options.prompt, document: promptTextContent(options.prompt) })
}

function seedEmptyLaunchDraft(
  state: StructuredLaunchState,
  change: NativeChatComposerDraftChange
): void {
  const { sessionId, worktreeId, executionHostId } = state.intent
  const scopeKey = structuredAgentSessionDraftScopeKey(sessionId)
  const current = readNativeChatComposerDraft(scopeKey)
  if (current.text !== '' || current.document) {
    return
  }
  updateNativeChatComposerDraft(
    scopeKey,
    { ...change, owner: { workspaceId: worktreeId, executionHostId } },
    'immediate',
    undefined,
    {
      at: 'end',
      target: findStructuredLaunchTab(state.intent)?.id ?? structuredAgentSessionTabId(sessionId),
      pending: true
    }
  )
}
