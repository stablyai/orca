// The people whose tabs a shared agent's Home holds, as the person filters name them: the viewer first.
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import { useBotHostHas } from '@/lib/bot-host-status'
import { BOTS_TAB_LIST_VIEWS_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { Bot } from '../../../../../shared/bot-types'
import { botPeoplePicker, type BotChatPersonPick } from '../../../../../shared/bots/bot-chat-people'
import { sameTabListPerson, type TabListPerson } from './viewed-tab-list'

export type TabListPersonEntry = { person: TabListPerson; name: string }

export type TabListPeople = { own: TabListPersonEntry; others: TabListPersonEntry[] }

/** The list a Chats or Items pick names: the owner's, or a teammate's by account. */
export function tabListPersonOf(pick: BotChatPersonPick): TabListPerson | null {
  return pick.kind === 'owner'
    ? 'owner'
    : pick.kind === 'person'
      ? { accountId: pick.person.accountId }
      : null
}

/** The list this window's own tabs are: the owner's on the owner's copy, else this teammate's. */
export function viewerTabListPerson(bot: Pick<Bot, 'shareViewer'>): TabListPerson {
  return bot.shareViewer ? { accountId: bot.shareViewer.accountId } : 'owner'
}

/** The list a pick shows in the Home: null for everyone or the viewer's own (their own tabs). */
export function viewedListOfPick(
  bot: Pick<Bot, 'shareViewer'>,
  pick: BotChatPersonPick
): TabListPerson | null {
  const person = tabListPersonOf(pick)
  return person && !sameTabListPerson(person, viewerTabListPerson(bot)) ? person : null
}

/** Whether the agent's host can show another person's list; an older one would answer with this
 *  viewer's own, so no one else's tabs show there. */
export function useTabListViews(bot: Pick<Bot, 'hostId'> | null): boolean {
  const has = useBotHostHas(bot?.hostId ?? LOCAL_EXECUTION_HOST_ID, BOTS_TAB_LIST_VIEWS_CAPABILITY)
  return bot !== null && has
}

/** Null for an agent shared with no one, or on a host that can't show their lists. */
export function useTabListPeople(bot: Bot | null): TabListPeople | null {
  const t = useTranslate()
  const account = useBotHostOrcaAccount(bot?.hostId ?? 'local')
  const views = useTabListViews(bot)
  if (!bot || !views) {
    return null
  }
  const ownName =
    account?.state === 'signed-in' ? (account.displayName ?? account.email ?? null) : null
  const entries = botPeoplePicker(bot, bot.shareViewer ? null : ownName)
  if (!entries) {
    return null
  }
  const named = entries.flatMap(({ pick, name }, index) => {
    const person = tabListPersonOf(pick)
    const fallback =
      index === 0
        ? t('bots.chats.filter.you', 'You')
        : person === 'owner'
          ? t('bots.items.filter.owner', 'Owner')
          : t('bots.teammateTabs.teammate', 'Teammate')
    return person ? [{ person, name: name || fallback }] : []
  })
  const [own, ...others] = named
  return own ? { own, others } : null
}
