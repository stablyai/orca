// The items of a bot's list one `botsChanged` notice can have changed, so the list reads just those.
import {
  BOT_CHANGE_KINDS,
  botChangeConcerns,
  type BotChangeKind,
  type BotChangeScope
} from './bot-change-scope'

/** A part standing for every loaded item that links a worker, named when the read starts (a page
 *  landed since the notice included). */
export const BOT_ITEMS_WORKER_LINKED = '\u0000worker-linked'

/** Those the notice names for the bot; a change of its workers names the items that link one
 *  (`BOT_ITEMS_WORKER_LINKED`). Null when the list must read whole: an items change names no items,
 *  a workers change comes from a host that can't read by uid, the notice names no kinds, or a kind
 *  this build doesn't know changed. */
export function botItemsNoticeParts(
  scope: BotChangeScope | undefined,
  botId: string
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
  const parts: string[] = []
  if (concerns('workers')) {
    if (!scope.namesItems) {
      return null
    }
    parts.push(BOT_ITEMS_WORKER_LINKED)
  }
  if (concerns('items')) {
    const named = scope.itemUids?.[botId]
    if (!named) {
      return null
    }
    parts.push(...named)
  }
  return parts
}
