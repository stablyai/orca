import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { Users } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { botGroupSingleRecipient } from '../../../../shared/bots/bot-group-mentions'
import type { NativeChatComposerRoom } from '../native-chat/composer/native-chat-composer-types'
import { subscribeToNativeChatComposerDraft } from '../native-chat/drafts/native-chat-composer-draft-store'
import { readNativeChatDraftCache } from '../native-chat/drafts/native-chat-draft-views'
import { BotAvatar } from './BotAvatar'
import { BotGroupReplyPicker } from './BotGroupReplyPicker'

/** The group composer's room: `@` lists members, and who would answer the current draft. */
export function useBotGroupComposerRoom(
  draftScope: string,
  group: BotGroup | undefined,
  bots: readonly Bot[],
  onGroupChange: (group: BotGroup) => void
): {
  room: NativeChatComposerRoom | undefined
  mentionNames: string[]
  recipientId: string | null
} {
  const t = useTranslate()
  const subscribeDraft = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(draftScope, listener),
    [draftScope]
  )
  // Model and permission controls belong to one bot, so they show only while exactly one would answer.
  const recipientId = useSyncExternalStore(subscribeDraft, () =>
    group ? botGroupSingleRecipient(readNativeChatDraftCache(draftScope), group, bots) : null
  )
  const memberBots = useMemo(
    () => bots.filter((bot) => group?.members.some((member) => member.botId === bot.id)),
    [bots, group]
  )
  // Keyed by the names so transcript markdown keeps its extension across transcript polls.
  const namesKey = memberBots.map((bot) => bot.name).join('\n')
  const mentionNames = useMemo(() => (namesKey ? namesKey.split('\n') : []), [namesKey])
  const changeGroup = useLatestHandler(onGroupChange)
  const room = useMemo<NativeChatComposerRoom | undefined>(
    () =>
      group && {
        replies: (draft) => (
          <BotGroupReplyPicker group={group} draft={draft} onChange={changeGroup} />
        ),
        mentions: [
          ...memberBots.map((bot) => ({
            name: bot.name,
            icon: <BotAvatar bot={bot} className="size-5 shrink-0" />
          })),
          {
            name: 'everyone',
            icon: <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          }
        ],
        placeholder: t('bots.groups.composerPlaceholder', 'Message the group, @ to mention a bot')
      },
    [changeGroup, group, memberBots, t]
  )
  return { room, mentionNames, recipientId }
}
