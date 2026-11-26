// The person pick both Chats' and Items' filters open with: everyone, the viewer's own, or another person's.
import { Check, Users } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import type { Bot } from '../../../../shared/bot-types'
import {
  botPeoplePicker,
  sameBotPersonPick,
  type BotChatPersonPick
} from '../../../../shared/bots/bot-chat-people'
import { BotOwnerAvatar } from './bot-connector-people'

/** The owner as the pick names them: "<name> (you)", else "You". */
export function useBotOwnPersonLabel(bot: Bot): string {
  const t = useTranslate()
  const account = useBotHostOrcaAccount(bot.hostId)
  const ownName =
    account?.state === 'signed-in' ? (account.displayName ?? account.email ?? null) : null
  return ownName
    ? t('bots.teamShare.you', '{{name}} (you)', { name: ownName })
    : t('bots.chats.filter.you', 'You')
}

/** One person the pick offers, labelled; the viewer leads. */
export type BotPersonPickLabelled = { pick: BotChatPersonPick; label: string }

/** What the pick shows by name; null for everyone. */
export function botPersonPickName(
  pick: BotChatPersonPick,
  entries: readonly BotPersonPickLabelled[]
): string | null {
  return pick.kind === 'everyone'
    ? null
    : (entries.find((entry) => sameBotPersonPick(entry.pick, pick))?.label ?? null)
}

/** The Items filter's people as its viewer sees them, labelled: "<name> (you)" first. Null for an
 *  agent shared with no one. */
export function useBotItemsPeople(bot: Bot): BotPersonPickLabelled[] | null {
  const t = useTranslate()
  const ownerLabel = useBotOwnPersonLabel(bot)
  const entries = botPeoplePicker(bot, null)
  if (!entries) {
    return null
  }
  return entries.map((entry, index) => ({
    pick: entry.pick,
    label:
      index === 0
        ? bot.shareViewer
          ? entry.name
            ? t('bots.teamShare.you', '{{name}} (you)', { name: entry.name })
            : t('bots.chats.filter.you', 'You')
          : ownerLabel
        : (entry.name ?? t('bots.items.filter.owner', 'Owner'))
  }))
}

function PickItem({
  checked,
  lead,
  label,
  onSelect
}: {
  checked: boolean
  lead: React.ReactNode
  label: string
  onSelect: () => void
}): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      {lead}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked ? <Check className="ml-auto" /> : <span className="size-4 shrink-0" />}
    </DropdownMenuItem>
  )
}

const personLead = (
  <span className="size-4 shrink-0">
    <BotOwnerAvatar iconClassName="size-2.5" />
  </span>
)

export function BotPersonPickItems({
  entries,
  pick,
  onPick
}: {
  /** The viewer first, then everyone else. */
  entries: readonly BotPersonPickLabelled[]
  pick: BotChatPersonPick
  onPick: (pick: BotChatPersonPick) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <PickItem
        checked={pick.kind === 'everyone'}
        lead={<Users />}
        label={t('bots.chats.filter.everyone', 'Everyone')}
        onSelect={() => onPick({ kind: 'everyone' })}
      />
      <DropdownMenuSeparator />
      <div className="scrollbar-sleek max-h-[15rem] overflow-y-auto">
        {entries.map((entry) => (
          <PickItem
            key={entry.pick.kind === 'person' ? entry.pick.person.accountId : entry.pick.kind}
            checked={sameBotPersonPick(entry.pick, pick)}
            lead={personLead}
            label={entry.label}
            onSelect={() => onPick(entry.pick)}
          />
        ))}
      </div>
    </>
  )
}
