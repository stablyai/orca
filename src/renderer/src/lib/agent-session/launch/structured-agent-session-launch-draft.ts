import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { findStructuredLaunchTab } from './structured-agent-session-launch-surface'
import {
  deleteNativeChatComposerDraft,
  appendToNativeChatComposerDraft,
  nativeChatComposerDraftWriteSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import type { NativeChatComposerDraftChange } from '@/components/native-chat/native-chat-composer-draft-store'
import { promptTextContent } from '@/components/native-chat/native-chat-prompt-document-text'
import type { StructuredAgentLaunchOptions } from './structured-agent-session-launch-callers'
import type { StructuredLaunchState } from './structured-agent-session-launch-registry'

type DraftDestination = Pick<
  StructuredLaunchState['intent'],
  'sessionId' | 'worktreeId' | 'executionHostId'
>

export async function moveStructuredAgentLaunchDraft(
  destination: DraftDestination,
  sourceScope: string,
  selection?: { from: number; to: number }
): Promise<void> {
  const scopeKey = structuredAgentSessionDraftScopeKey(destination.sessionId)
  if (scopeKey === sourceScope) {
    return
  }
  const source = readNativeChatComposerDraft(sourceScope)
  if (source.text !== '' || source.images.length > 0) {
    const journaled = appendToNativeChatComposerDraft(
      scopeKey,
      source,
      { workspaceId: destination.worktreeId, executionHostId: destination.executionHostId },
      (merged) => {
        const offset = Math.max(0, merged.text.lastIndexOf(source.text))
        return {
          ...(selection
            ? { at: 'selection', from: offset + selection.from, to: offset + selection.to }
            : { at: 'end' }),
          target:
            findStructuredLaunchTab(destination)?.id ??
            structuredAgentSessionTabId(destination.sessionId),
          pending: true
        }
      }
    )
    if (!journaled && !(await nativeChatComposerDraftWriteSettled(scopeKey))) {
      return
    }
  }
  if (readNativeChatComposerDraft(sourceScope) === source) {
    deleteNativeChatComposerDraft(sourceScope)
  }
}

export function seedStructuredAgentLaunchDraft(
  state: StructuredLaunchState,
  options: StructuredAgentLaunchOptions
): void {
  if (options.draftFromScope) {
    void moveStructuredAgentLaunchDraft(state.intent, options.draftFromScope)
  }
  if (options.promptDelivery !== 'draft' || !options.prompt) {
    return
  }
  seedEmptyLaunchDraft(state.intent, {
    text: options.prompt,
    document: promptTextContent(options.prompt)
  })
}

function seedEmptyLaunchDraft(
  destination: DraftDestination,
  change: NativeChatComposerDraftChange
): boolean {
  const { sessionId, worktreeId, executionHostId } = destination
  const scopeKey = structuredAgentSessionDraftScopeKey(sessionId)
  const current = readNativeChatComposerDraft(scopeKey)
  if (current.text !== '' || current.document) {
    return false
  }
  updateNativeChatComposerDraft(
    scopeKey,
    { ...change, owner: { workspaceId: worktreeId, executionHostId } },
    'immediate',
    undefined,
    {
      at: 'end',
      target: findStructuredLaunchTab(destination)?.id ?? structuredAgentSessionTabId(sessionId),
      pending: true
    }
  )
  return true
}
