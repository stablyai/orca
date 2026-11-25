import React from 'react'
import { Users } from 'lucide-react'
import { useBots } from '@/lib/bot-catalog'
import { useBotGroups } from '@/lib/bot-group-list'
import type { Bot } from '../../../../shared/bot-types'
import { findBotGroupRoom } from '../../../../shared/bots/bot-group'
import { botGroupTabFaces } from '../../../../shared/bots/bot-group-face-layout'
import { BotGroupFaces } from './BotGroupFaces'

/** A room tab's group members, the original room's or a thread's, as loaded; none for any
 *  other tab. */
export function useBotGroupTabMembers(roomId: string | null): readonly Bot[] {
  const groups = useBotGroups(roomId !== null)
  const group = roomId ? findBotGroupRoom(groups, roomId)?.group : undefined
  const bots = useBots(roomId !== null)
  return (group?.members ?? []).flatMap(
    (member) => bots.find((bot) => bot.id === member.botId && bot.hostId === group?.hostId) ?? []
  )
}

/** A group room tab's icon: its first two members' faces. The tab names everyone. */
export function BotGroupTabIcon({ members }: { members: readonly Bot[] }): React.JSX.Element {
  // Until the group and its bots load, the generic group glyph holds the slot.
  if (members.length === 0) {
    return <Users className="size-3" />
  }
  return (
    <BotGroupFaces
      faces={botGroupTabFaces(members, (bot) => bot.id)}
      className={members.length > 1 ? 'h-3 w-5' : 'size-3'}
    />
  )
}
