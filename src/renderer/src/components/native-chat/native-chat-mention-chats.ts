// One level under a bot in the `@` list: its chats this chat can mail now, and how a picked one reads.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { botMentionsAt } from '../../../../shared/bots/bot-mention-context'

/** One of a bot's chats, as its row in the bot's Activity panel shows it. */
export type NativeChatMentionChat = {
  id: string
  title: string
  /** What typing after the bot filters on: the title and the second line. */
  search: string
  icon: ReactNode
  line: ReactNode
  time: string | null
  /** Picking it gives the plain bot pill: another bot's Home Chat, which `bot:` alone reaches. */
  plain: boolean
}

export type NativeChatMentionChatsView =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; chats: readonly NativeChatMentionChat[] }

/** A picked chat as Send may carry it: still being checked, fine, or not, with why in a sentence. */
export type NativeChatBotChatPick =
  | { state: 'checking' }
  | { state: 'ok' }
  | { state: 'unavailable'; why: ReactNode; retry?: () => void }

/** A chat composer's way into its bots' chats; absent where none can be picked. */
export type NativeChatBotChatPicker = {
  /** The bot's row offers Chats ›: its host takes chat picks and it isn't paused. */
  offers: (botId: string) => boolean
  /** The chat's own bot: listed first, and Enter or Tab on it opens its chats. */
  selfId: string | null
  /** The bots the draft's chat pills name, so their chats are read and kept current. */
  watch: (botIds: readonly string[]) => void
  /** Starts reading the bot's chats, as a highlighted row does. */
  prefetch: (botId: string) => void
  /** The bot whose chats a list shows now; null closes it. */
  view: (botId: string | null) => void
  shown: {
    botId: string
    name: string
    avatar: ReactNode
    chats: NativeChatMentionChatsView
  } | null
  retry: () => void
  /** What picking `chat` (null: the bot alone) puts in the draft. */
  token: (botId: string, chat: NativeChatMentionChat | null) => string
  /** Whether Send may carry a picked chat; a host that can't take chat picks never may. */
  pick: (botId: string, chatId: string) => NativeChatBotChatPick
  /** The picked chat's title as it reads now, looked up by id. */
  title: (botId: string, chatId: string) => ReactNode
}

/** The draft's chat pills, kept checked: the first one Send can't carry, and which pill's chat list
 *  is open. Nothing is sent in a picked chat's place, so any doubt holds Send. */
export function useBotChatPillChecks(draft: string, picker: NativeChatBotChatPicker | undefined) {
  const pills = useMemo(() => botMentionsAt(draft), [draft])
  const chatBots = useMemo(
    () => [...new Set(pills.filter((pill) => pill.chatId).map((pill) => pill.id))],
    [pills]
  )
  const watch = picker?.watch
  const watchKey = chatBots.join('|')
  useEffect(() => {
    watch?.(watchKey ? watchKey.split('|') : [])
  }, [watch, watchKey])
  const held = firstHeldPill(pills, picker)
  const [at, setAt] = useState<number | null>(null)
  const chooser = useMemo(
    () => ({ at, open: (index: number) => setAt(index), close: () => setAt(null) }),
    [at]
  )
  return useMemo(() => ({ pills, held, chooser }), [pills, held, chooser])
}

/** The first chat pill Send can't carry yet, with its place among the bot pills; null when none. */
function firstHeldPill(
  pills: ReturnType<typeof botMentionsAt>,
  picker: NativeChatBotChatPicker | undefined
) {
  for (const [index, pill] of pills.entries()) {
    if (!pill.chatId) {
      continue
    }
    const pick = picker
      ? picker.pick(pill.id, pill.chatId)
      : // No bots known here: nothing can say the chat takes mail.
        { state: 'checking' as const }
    if (pick.state !== 'ok') {
      return { ...pill, index, pick }
    }
  }
  return null
}
