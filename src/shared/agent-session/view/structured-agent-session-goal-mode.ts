import type { NativeChatPickerItem } from '../../native-chat/input/native-chat-picker-items'
import { applyPickerSuggestion } from '../../native-chat/input/native-chat-picker-triggers'

/** Without host goals only the provider's built-in /goal opens goal mode; a namesake keeps its invocation. */
export function structuredAgentSessionPickEntersGoalMode(
  item: NativeChatPickerItem,
  hostSetsGoals: boolean
): boolean {
  return item.kind === 'command' && item.name === 'goal' && (hostSetsGoals || item.builtin === true)
}

/** The draft after a pick that enters goal mode: the chip replaces the `/goal ` token the pick would insert. */
export function structuredAgentSessionGoalModeDraft(
  draft: string,
  caret: number,
  item: NativeChatPickerItem
): { draft: string; caret: number } {
  const inserted = applyPickerSuggestion(draft, caret, item)
  const tokenStart = inserted.caret - item.token.length - 1
  return {
    draft: inserted.draft.slice(0, tokenStart) + inserted.draft.slice(inserted.caret),
    caret: tokenStart
  }
}
