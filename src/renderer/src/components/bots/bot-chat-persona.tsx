import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { useBotHome } from '../settings/bots/use-bot-home-file'
import type { NativeChatPersona } from '../native-chat/host-access/NativeChatEmptyState'
import { useBotForWorkspace } from './bot-workspace'
import { BotAvatar } from './BotAvatar'
import { useBotSoulDescription } from './bot-soul-description'

/** The first paragraph of the bot's SOUL.md; null until it has one of its own. */
export function useBotDescription(bot: Bot | null): string | null {
  return useBotSoulDescription(useBotHome(bot))
}

/** A chat in a bot's home greets as the bot: its picture, its name and its SOUL.md description. */
export function useBotChatPersona(workspaceId: string | null): NativeChatPersona | null {
  const t = useTranslate()
  const bot = useBotForWorkspace(workspaceId)
  const description = useBotDescription(bot)
  if (!bot) {
    return null
  }
  return {
    icon: <BotAvatar bot={bot} size="large" className="size-14 rounded-xl text-xl" />,
    name: bot.name,
    subtitle:
      description ??
      t(
        'bots.chat.emptySubtitle',
        'Ask {{name}} anything. It remembers what matters across chats.',
        { name: bot.name }
      )
  }
}
