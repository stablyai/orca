// The people whose tabs a shared agent's Home holds, as the person filters name them: the viewer first.
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import type { Bot } from '../../../../../shared/bot-types'
import { botPeoplePicker, type BotChatPersonPick } from '../../../../../shared/bots/bot-chat-people'
import { sameTabListPerson, type TabListPerson } from './viewed-tab-list'
import type { BotChatPerson } from '../../../../../shared/bots/bot-chat-tree'

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

/** The list a pick shows in the Home: null for everyone or the viewer's own (their own tabs). */
export function viewedListOfPick(
  bot: Pick<Bot, 'shareViewer'>,
  pick: BotChatPersonPick
): TabListPerson | null {
  const person = tabListPersonOf(pick)
  const own: TabListPerson = bot.shareViewer ? { accountId: bot.shareViewer.accountId } : 'owner'
  return person && !sameTabListPerson(person, own) ? person : null
}

/** The pick that names a viewed list, among the people a filter offers. */
export function pickOfViewedList(
  person: TabListPerson,
  people: readonly BotChatPerson[]
): BotChatPersonPick | null {
  if (person === 'owner') {
    return { kind: 'owner' }
  }
  const named = people.find((entry) => entry.accountId === person.accountId)
  return named ? { kind: 'person', person: named } : null
}

/** Null for an agent shared with no one: there is no one else's list to show. */
export function useTabListPeople(bot: Bot | null): TabListPeople | null {
  const t = useTranslate()
  const account = useBotHostOrcaAccount(bot?.hostId ?? 'local')
  if (!bot) {
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
