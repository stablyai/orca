import type { NativeChatPickerItem } from '../../../../shared/native-chat-picker-items'

// Send classification lives in shared so mobile gates optimistic echoes with
// the same rules; re-exported here to keep renderer import paths stable.
export {
  classifyNativeChatSend,
  type NativeChatSendClassification
} from '../../../../shared/native-chat-slash-commands'
// The row builder is shared with the phone; re-exported for the same reason.
export {
  buildNativeChatPickerItems,
  type NativeChatPickerItem,
  type NativeChatSessionSkill,
  type NativeChatSkillDiscoverySnapshot
} from '../../../../shared/native-chat-picker-items'

// `/` is the composer's only trigger, for every agent. A draft-leading slash is
// the one that can dispatch; elsewhere the token starts after whitespace and its
// query stops at the next `/` so file paths stay prose.
export const LEADING_SLASH_TRIGGER = /^\/(\S*)$/
export const MID_PROMPT_SLASH_TRIGGER = /\s\/([^\s/]*)$/

/** Replaces the typed `/token` with the item's own token, which for a skill is
 *  the agent-native form even though every agent is typed the same way. */
export function applyPickerSuggestion(
  draft: string,
  caret: number,
  item: NativeChatPickerItem
): { draft: string; caret: number; insertedToken: string } {
  const before = draft.slice(0, caret)
  const after = draft.slice(caret)
  const match = before.match(LEADING_SLASH_TRIGGER) ?? before.match(MID_PROMPT_SLASH_TRIGGER)
  if (!match) {
    return { draft, caret, insertedToken: '' }
  }
  const query = match.at(-1) ?? ''
  const tokenStart = before.length - query.length - 1
  const nextBefore = `${before.slice(0, tokenStart)}${item.token} `
  return { draft: nextBefore + after, caret: nextBefore.length, insertedToken: item.token }
}
