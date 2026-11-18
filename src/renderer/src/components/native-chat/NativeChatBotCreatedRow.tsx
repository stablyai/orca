import { useContext } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import type { Bot } from '../../../../shared/bot-types'
import type { TookOverNotice } from '../../../../shared/native-chat/took-over-notice'
import { useTranslation } from 'react-i18next'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { BotAvatar } from '@/components/bots/BotAvatar'
import { useBotDescription } from '@/components/bots/bot-chat-persona'
import { useTranslate } from '@/i18n/use-translate'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { NativeChatDividerRow } from './NativeChatDividerRow'
import { NativeChatBotKickoffContext } from './native-chat-bot-kickoff-view'
import { NativeChatMessageTimestamp } from './messages/rows/NativeChatMessageTimestamp'
import { useNativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'

/** Orca's first turn to a bot it just created, which the owner never typed: in the bot's Home, the
 *  bot's own header (picture, name, what it is for), else a notice. */
export function NativeChatBotCreatedRow({
  messageId,
  timestamp
}: {
  messageId: string
  timestamp: number | null
}): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const bot = useBotForWorkspace(useNativeChatVisualOwner()?.worktreeId ?? null)
  const firstKickoffId = useContext(NativeChatBotKickoffContext)?.firstKickoffId
  if (bot && (firstKickoffId ?? messageId) === messageId) {
    return <NativeChatBotHeader bot={bot} />
  }
  const label = bot
    ? t('components.native-chat.botCreated.again', '{{name}} started setting up again', {
        name: bot.name
      })
    : t('components.native-chat.botCreated.unnamed', 'Bot created')
  return (
    <NativeChatDividerRow label={label}>
      {label}
      {timestamp !== null ? <span aria-hidden>·</span> : null}
      <NativeChatMessageTimestamp timestamp={timestamp} />
    </NativeChatDividerRow>
  )
}

/** The bot's own header atop its Home: picture, name, what it is for. */
function NativeChatBotHeader({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const description = useBotDescription(bot)
  const runs = t('bots.header.runs', 'runs your {{agent}}', {
    agent: botAgentLabel(bot.agent)
  })
  return (
    <div className="flex items-center gap-3 border-b border-border pb-4">
      <BotAvatar bot={bot} className="size-9 rounded-lg text-base" />
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-semibold text-chat-foreground-strong">{bot.name}</span>
        <span className="truncate text-xs text-chat-foreground-faint">
          {`${description ?? t('bots.header.newBot', 'Your new bot')} · ${runs}`}
        </span>
      </div>
    </div>
  )
}

/** Orca's turn handing the bot a workspace: a divider naming it, under the bot's header in the Home
 *  of a bot just made for it. The goal, if any, is drawn after it as the owner's words. */
export function NativeChatTookOverRow({
  tookOver,
  timestamp
}: {
  tookOver: TookOverNotice | undefined
  timestamp: number | null
}): React.JSX.Element | null {
  const t = useTranslate()
  useTranslation()
  const bot = useBotForWorkspace(useNativeChatVisualOwner()?.worktreeId ?? null)
  if (!tookOver) {
    return null
  }
  const label = t('components.native-chat.tookOver', 'Took over {{workspace}}', {
    workspace: tookOver.workspace
  })
  return (
    <div className="flex flex-col gap-4">
      {bot && tookOver.home ? <NativeChatBotHeader bot={bot} /> : null}
      <NativeChatDividerRow label={label}>
        <ArrowRightLeft className="size-3" aria-hidden />
        {label}
        {timestamp !== null ? <span aria-hidden>·</span> : null}
        <NativeChatMessageTimestamp timestamp={timestamp} />
      </NativeChatDividerRow>
    </div>
  )
}
