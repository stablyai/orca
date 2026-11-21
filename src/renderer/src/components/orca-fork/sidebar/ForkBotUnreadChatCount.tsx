import React from 'react'
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { FORK_FEATURES } from '../../../../../shared/orca-fork/fork-features'
import { useBotOwnChatTree } from '../../bots/use-bot-chat-tree'

/** `children` (the row line's trailing), led by how many of the bot's open chats have something its
 *  owner hasn't read; the count shows nothing at zero or while the bot's host is offline. */
export function ForkBotUnreadChatCount({
  bot,
  offline,
  children
}: {
  bot: Bot
  offline: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      {FORK_FEATURES.sidebarUnreadChatCount && !offline ? <UnreadChatCount bot={bot} /> : null}
      {children}
    </>
  )
}

function UnreadChatCount({ bot }: { bot: Bot }): React.JSX.Element | null {
  const t = useTranslate()
  const { chats } = useBotOwnChatTree(bot)
  const count = chats.filter((chat) => chat.unread && !chat.closed).length
  if (count === 0) {
    return null
  }
  const label = t('orcaFork.bots.unreadChats', '{{count}} unread chats', {
    count,
    defaultValue_one: '{{count}} unread chat'
  })
  return (
    <Badge role="img" aria-label={label} title={label} className="shrink-0">
      {count}
    </Badge>
  )
}
