import { useContext } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import type { Bot } from '../../../../shared/bot-types'
import type { TookOverNotice } from '../../../../shared/native-chat/took-over-notice'
import { useTranslation } from 'react-i18next'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { BotAvatar } from '@/components/bots/BotAvatar'
import { openBotSettings } from '@/components/bots/bot-settings-open'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatDividerRow } from './NativeChatDividerRow'
import { NativeChatBotKickoffContext } from './native-chat-bot-kickoff-view'
import { NativeChatMessageTimestamp } from './messages/rows/NativeChatMessageTimestamp'
import { useNativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'

/** Orca's first turn to a bot it just created, which the owner never typed: in the bot's Home, the
 *  bot's own header (picture, name, when it started), else a notice. */
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
    return <NativeChatBotHeader bot={bot} timestamp={timestamp} />
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

/** The bot's own header atop its Home: a pill with its picture and name that opens its settings,
 *  where what it is for and what it runs live, then when it started. Scrolls away with the chat. */
function NativeChatBotHeader({
  bot,
  timestamp
}: {
  bot: Bot
  timestamp: number | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col items-center gap-1.5 pb-3">
      <button
        type="button"
        aria-label={t('bots.header.open', 'Open {{name}} settings', { name: bot.name })}
        onClick={() => openBotSettings(bot.id)}
        className="flex h-[38px] max-w-full min-w-0 items-center gap-2 rounded-full border border-border py-[5px] pr-3.5 pl-1.5 text-sm font-semibold text-chat-foreground-strong transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <BotAvatar bot={bot} className="size-7 shrink-0 rounded-md text-sm" />
        <span className="min-w-0 truncate">{bot.name}</span>
      </button>
      <NativeChatMessageTimestamp timestamp={timestamp} />
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
      {bot && tookOver.home ? <NativeChatBotHeader bot={bot} timestamp={null} /> : null}
      <NativeChatDividerRow label={label}>
        <ArrowRightLeft className="size-3" aria-hidden />
        {label}
        {timestamp !== null ? <span aria-hidden>·</span> : null}
        <NativeChatMessageTimestamp timestamp={timestamp} />
      </NativeChatDividerRow>
    </div>
  )
}
