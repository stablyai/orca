// End chat on a bot side chat's tab menu, beside Close: Close keeps working chats in the background,
// End chat ends one that has nothing left to do.
import { CircleX } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostHas } from '@/lib/bot-host-status'
import { BOTS_END_CHAT_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { useBotForWorkspace } from './bot-workspace'
import { endBotChatFromRow } from './bot-chat-end'

export function BotChatEndTabMenuItem({
  worktreeId,
  sessionId
}: {
  worktreeId: string
  sessionId: string | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const bot = useBotForWorkspace(worktreeId)
  const supported = useBotHostHas(bot?.hostId ?? 'local', BOTS_END_CHAT_RUNTIME_CAPABILITY)
  if (!bot || !sessionId || bot.chatSessionId === sessionId || !supported) {
    return null
  }
  return (
    <ContextMenuItem onSelect={() => void endBotChatFromRow(bot, sessionId)}>
      <CircleX className="size-3.5" />
      {t('bots.endChat.menuItem', 'End chat')}
    </ContextMenuItem>
  )
}
