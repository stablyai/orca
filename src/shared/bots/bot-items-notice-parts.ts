// The items of a bot's list one `botsChanged` notice can have changed, so the list reads just those.
import {
  BOT_CHANGE_KINDS,
  botChangeConcerns,
  type BotChangeKind,
  type BotChangeScope
} from './bot-change-scope'
import type { BotItem } from './bot-items'

/** Those the notice names for the bot, and for a change of its workers the host didn't name the
 *  loaded items that link a worker still going (only they show one that can change). Null when the list must read whole: the notice names nothing, an
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
  // A host that named every worker change's items sent them as an items notice of their own.
  if (concerns('workers') && !scope.workersNamed) {
    if (!items) {
      return null
    }
    // A finished worker no longer changes; one still going (or not yet known) can.
    for (const item of items) {
      if (
        item.links.some(
          (link) =>
            link.kind === 'dispatch' && (link.state === 'working' || link.state === 'unknown')
        )
      ) {
        parts.add(item.uid)
      }
    }
  }
  return [...parts]
}
