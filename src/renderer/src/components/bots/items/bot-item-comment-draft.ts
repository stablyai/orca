// An item's comment box draft, kept in chat's draft store so it outlives the box.
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import { readNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { writeNativeChatDraftCache } from '../../native-chat/drafts/native-chat-draft-views'

export function botItemCommentDraftScope(bot: BotRef, uid: string): string {
  return `bot-item-comment:${botRefKey(bot)}:${uid}`
}

/** Puts a dropped comment's words back in the box, unless the owner has typed or attached since. */
export function returnBotItemCommentDraft(bot: BotRef, uid: string, text: string): void {
  const scope = botItemCommentDraftScope(bot, uid)
  const draft = readNativeChatComposerDraft(scope)
  if (text.trim() && !draft.text.trim() && draft.images.length === 0) {
    writeNativeChatDraftCache(scope, text)
  }
}
