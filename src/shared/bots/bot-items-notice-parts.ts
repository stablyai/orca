// The items of a bot's list one `botsChanged` notice can have changed, so the list reads just those.
import {
  BOT_CHANGE_KINDS,
  botChangeConcerns,
  type BotChangeKind,
  type BotChangeScope
} from './bot-change-scope'

/** Those the notice names for the bot; none for a change of its workers the host already named as
 *  items. Null when the list must read whole: the notice names nothing, its items or workers change
 *  names no items (an older host, a reset), or a kind this build doesn't know changed. */
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
  if (concerns('workers') && !scope.workersNamed) {
    return null
  }
  if (!concerns('items')) {
    return []
  }
  return scope.itemUids?.[botId] ?? null
}
