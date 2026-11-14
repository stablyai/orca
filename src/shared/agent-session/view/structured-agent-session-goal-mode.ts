import type { NativeChatPickerItem } from '../../native-chat/input/native-chat-picker-items'
import { applyPickerSuggestion } from '../../native-chat/input/native-chat-picker-triggers'

/** Without host goals only the provider's built-in /goal opens goal mode; a namesake keeps its invocation. */
export function structuredAgentSessionPickEntersGoalMode(
  item: NativeChatPickerItem,
  hostSetsGoals: boolean
): boolean {
  return item.kind === 'command' && item.name === 'goal' && (hostSetsGoals || item.builtin === true)
}

/** A mode chip replaces only the picked command, preserving the surrounding draft. */
export function structuredAgentSessionModePickDraft(
  draft: string,
  caret: number,
  item: NativeChatPickerItem
): { draft: string; caret: number } | null {
  const inserted = applyPickerSuggestion(draft, caret, item)
  if (!inserted.insertedToken) {
    return null
  }
  const tokenStart = inserted.caret - item.token.length - 1
  return {
    draft: inserted.draft.slice(0, tokenStart) + inserted.draft.slice(inserted.caret),
    caret: tokenStart
  }
}
