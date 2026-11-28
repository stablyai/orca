// Keeps each group member's Needs you count published while the group's right sidebar is open,
// even when another tab (such as a plugin panel) unmounts BotGroupItemsPanel.
import { memo, type ReactElement } from 'react'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import { useBotNeedsYouCount, useBotNow } from './use-bot-now'

const MemberNeedsYouPublisher = memo(function MemberNeedsYouPublisher({ bot }: { bot: Bot }): null {
  const now = useBotNow(bot)
  useBotNeedsYouCount(bot, now)
  return null
})

export const BotGroupNeedsYouPublishers = memo(function BotGroupNeedsYouPublishers({
  members
}: {
  members: readonly Bot[]
}): ReactElement | null {
  if (members.length === 0) {
    return null
  }
  return (
    <>
      {members.map((bot) => (
        <MemberNeedsYouPublisher key={botRefKey(bot)} bot={bot} />
      ))}
    </>
  )
})
