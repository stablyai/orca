import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { findStructuredLaunchTab } from './structured-agent-session-launch-surface'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import { moveNativeChatComposerDraft } from '@/components/native-chat/drafts/native-chat-composer-draft-move'
import type { NativeChatComposerDraftChange } from '@/components/native-chat/drafts/native-chat-composer-draft-storage'
import { promptTextContent } from '@/components/native-chat/composer/editor/native-chat-prompt-document-text'
import type { StructuredAgentLaunchOptions } from './structured-agent-session-launch-callers'
import type { StructuredLaunchState } from './structured-agent-session-launch-state-store'

type DraftDestination = Pick<
  StructuredLaunchState['intent'],
  'sessionId' | 'worktreeId' | 'executionHostId'
> & { params?: { tabId?: string } }

/**
 * Where the moved draft's selection lands in the merged one: inside the span the moved text itself
 * occupies, which is the merged text's end whenever the move contributed text (an exact duplicate the
 * receiver already ends with is that same text). A move with no span of its own there (empty,
 * image-only, whitespace-only, or text the receiver holds only in another form, such as trimmed) puts
 * the caret at the end, never at the start of the receiver's own text.
 */
function movedSelection(
  merged: string,
  moved: string,
  selection?: { from: number; to: number }
): { at: 'end' } | { at: 'selection'; from: number; to: number } {
  if (!selection || moved.trim() === '' || !merged.endsWith(moved)) {
    return { at: 'end' }
  }
  const offset = merged.length - moved.length
  const within = (at: number): number => offset + Math.min(Math.max(at, 0), moved.length)
  return { at: 'selection', from: within(selection.from), to: within(selection.to) }
}

export function moveStructuredAgentLaunchDraft(
  destination: DraftDestination,
  sourceScope: string,
  selection?: { from: number; to: number }
): void {
  const scopeKey = structuredAgentSessionDraftScopeKey(destination.sessionId)
  const source = readNativeChatComposerDraft(sourceScope)
  moveNativeChatComposerDraft(
    sourceScope,
    scopeKey,
    { workspaceId: destination.worktreeId, executionHostId: destination.executionHostId },
    (merged) => {
      return {
        ...movedSelection(merged.text, source.text, selection),
        target:
          findStructuredLaunchTab(destination)?.id ??
          destination.params?.tabId ??
          structuredAgentSessionTabId(destination.sessionId),
        pending: true
      }
    }
  )
}

export function seedStructuredAgentLaunchDraft(
  state: StructuredLaunchState,
  options: StructuredAgentLaunchOptions
): void {
  if (options.draftFromScope) {
    moveStructuredAgentLaunchDraft(state.intent, options.draftFromScope)
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
      target:
        findStructuredLaunchTab(destination)?.id ??
        destination.params?.tabId ??
        structuredAgentSessionTabId(sessionId),
      pending: true
    }
  )
  return true
}
