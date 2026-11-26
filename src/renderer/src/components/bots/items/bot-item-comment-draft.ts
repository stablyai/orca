// An item's comment box draft, kept in chat's draft store so it outlives the box.
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from '../../native-chat/drafts/native-chat-composer-draft-store'
import {
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '../../native-chat/drafts/native-chat-draft-views'
import {
  putBackBotItemReplyTarget,
  type BotItemReplyTargetStore
} from '../../../../../shared/bots/bot-item-reply-target'

export function botItemCommentDraftScope(bot: BotRef, uid: string): string {
  return `bot-item-comment:${botRefKey(bot)}:${uid}`
}

/** What each box's draft replies to, in the same draft store beside it, so a restart keeps both. */
export const botItemReplyTargetDrafts: BotItemReplyTargetStore = {
  read: readNativeChatDraftCache,
  write: (key, value) => writeNativeChatDraftCache(key, value),
  subscribe: subscribeToNativeChatComposerDraft
}

/** Puts a dropped comment's words back in the box, unless the owner has typed or attached since. */
export function returnBotItemCommentDraft(bot: BotRef, uid: string, text: string): void {
  const scope = botItemCommentDraftScope(bot, uid)
  const draft = readNativeChatComposerDraft(scope)
  if (text.trim() && !draft.text.trim() && draft.images.length === 0) {
    putBackBotItemReplyTarget(botItemReplyTargetDrafts, scope)
    writeNativeChatDraftCache(scope, text)
  }
}
