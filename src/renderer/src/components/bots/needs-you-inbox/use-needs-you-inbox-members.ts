// The bots the inbox reads: those with Needs you items, and every one read since it opened, in the order
// the sidebar saves them. An answered bot's count drops to none while its item still shows in the pane,
// so its read stays.
import { useMemo, useState } from 'react'
import { useBotHomeWorkspaces, useBots } from '@/lib/bot-catalog'
import { useBotGroups } from '@/lib/bot-group-list'
import { botRefKey } from '@/lib/bot-hosts'
import { useBotsNeedingOwner } from '@/lib/bots-needing-owner'
import type { Bot } from '../../../../../shared/bot-types'
import { getHostKeyedBotSidebarEntries } from '../bot-sidebar-entry-keys'

/** Fresh bot objects replace kept ones; the same list comes back while nothing changed. */
function keptBots(kept: readonly Bot[], bots: readonly Bot[]): readonly Bot[] {
  const fresh = new Map(bots.map((bot) => [botRefKey(bot), bot]))
  const keptKeys = new Set(kept.map(botRefKey))
  const next = [
    ...kept.map((bot) => fresh.get(botRefKey(bot)) ?? bot),
    ...bots.filter((bot) => !keptKeys.has(botRefKey(bot)))
  ]
  return next.length === kept.length && next.every((bot, index) => bot === kept[index])
    ? kept
    : next
}

export function useNeedsYouInboxMembers(): readonly Bot[] {
  const { bots } = useBotsNeedingOwner()
  const [members, setMembers] = useState<readonly Bot[]>(bots)
  const next = keptBots(members, bots)
  if (next !== members) {
    setMembers(next)
  }
  const catalog = useBots()
  const groups = useBotGroups()
  const homes = useBotHomeWorkspaces(catalog, groups)
  return useMemo(() => {
    const place = new Map(
      getHostKeyedBotSidebarEntries(catalog, groups, homes).flatMap((entry, index) =>
        entry.kind === 'bot' ? [[botRefKey(entry.bot), index] as const] : []
      )
    )
    const placeOf = (bot: Bot): number => place.get(botRefKey(bot)) ?? Number.MAX_SAFE_INTEGER
    return next.toSorted((a, b) => placeOf(a) - placeOf(b))
  }, [next, catalog, groups, homes])
}
