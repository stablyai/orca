// A host entry's Needs you counts, which a list read and an items notice both bring.
import type { BotNeedsYouCounts } from '../../../shared/bots/bot-change-scope'
import { reuseEqualJson } from '../../../shared/reuse-equal-json'

export type NeedsYouFields = {
  needsYou: Readonly<Record<string, number>> | undefined
  needsYouAt: number | undefined
  needsYouStaleAt: number | undefined
}

/** Takes the host's counts unless the entry holds a later count; none (an older host) clears them. */
export function takeNeedsYou(entry: NeedsYouFields, needsYou: BotNeedsYouCounts | undefined): void {
  if (!needsYou) {
    entry.needsYou = undefined
    entry.needsYouAt = undefined
    entry.needsYouStaleAt = undefined
    return
  }
  if (entry.needsYouAt !== undefined && needsYou.at < entry.needsYouAt) {
    return
  }
  entry.needsYou = reuseEqualJson(entry.needsYou, needsYou.counts)
  entry.needsYouAt = needsYou.at === -Infinity ? undefined : needsYou.at
  entry.needsYouStaleAt =
    needsYou.staleInMs !== undefined ? Date.now() + needsYou.staleInMs : undefined
}
