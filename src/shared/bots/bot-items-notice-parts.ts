// The items of a bot's list one `botsChanged` notice can have changed, so the list reads just those.
import {
  BOT_CHANGE_KINDS,
  botChangeConcerns,
  type BotChangeKind,
  type BotChangeScope
} from './bot-change-scope'
import type { BotItem } from './bot-items'

/** Those the notice names for the bot, and for a change of its workers the loaded items that link a
 *  worker (only they show one). Null when the list must read whole: the notice names nothing, an
 *  items change names no items, or a kind this build doesn't know changed. */
export function botItemsNoticeParts(
  scope: BotChangeScope | undefined,
  botId: string,
  items: readonly BotItem[] | null
): readonly string[] | null {
  if (!scope?.kinds?.length) {
    return null
  }
  const known = new Set<string>(BOT_CHANGE_KINDS)
  if (scope.kinds.some((kind) => !known.has(kind))) {
    return null
  }
  const concerns = (kind: BotChangeKind) =>
    scope.kinds?.includes(kind) === true &&
    botChangeConcerns({ ...scope, kinds: [kind] }, { botId, kinds: [kind] })
  const parts = new Set<string>()
  if (concerns('items')) {
    const named = scope.itemUids?.[botId]
    if (!named) {
      return null
    }
    named.forEach((uid) => parts.add(uid))
  }
  if (concerns('workers')) {
    if (!items) {
      return null
    }
    for (const item of items) {
      if (item.links.some((link) => link.kind === 'dispatch')) {
        parts.add(item.uid)
      }
    }
  }
  return [...parts]
}
