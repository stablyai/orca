import { useMemo, useSyncExternalStore } from 'react'
import { useBots } from '@/lib/bot-catalog'
import { readLiveBotHostIds, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { groupMemberKeys } from './bot-group-members-dialog-roster'

const NO_BOTS: readonly Bot[] = []

/** The group's members; a paired computer's only while connected (its stale read can't be paged), or while it owns the open item (`heldKey`). */
export function useBotGroupMembers(
  group: BotGroup | null,
  heldKey: string | null = null
): readonly Bot[] {
  const bots = useBots(group !== null)
  const live = useSyncExternalStore(subscribeToBotChanges, readLiveBotHostIds, readLiveBotHostIds)
  return useMemo(() => {
    if (!group) {
      return NO_BOTS
    }
    const byKey = new Map(bots.map((bot) => [botRefKey(bot), bot]))
    return groupMemberKeys(group).flatMap((key) => {
      const bot = byKey.get(key)
      return bot && (bot.hostId === group.hostId || key === heldKey || live.includes(bot.hostId))
        ? [bot]
        : []
    })
  }, [group, bots, live, heldKey])
}
