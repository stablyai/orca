// The person pick both Chats' and Items' filters open with: everyone, the owner's own, or one teammate's.
import { Check, Users } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatPerson } from '../../../../shared/bots/bot-chat-tree'
import type { BotChatPersonPick } from '../../../../shared/bots/bot-chat-people'
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

/** What the pick shows by name; null for everyone. */
export function botPersonPickName(pick: BotChatPersonPick, you: string): string | null {
  return pick.kind === 'person' ? pick.person.name : pick.kind === 'owner' ? you : null
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
  you,
  people,
  pick,
  onPick
}: {
  you: string
  people: readonly BotChatPerson[]
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
        <PickItem
          checked={pick.kind === 'owner'}
          lead={personLead}
          label={you}
          onSelect={() => onPick({ kind: 'owner' })}
        />
        {people.map((person) => (
          <PickItem
            key={person.accountId}
            checked={pick.kind === 'person' && pick.person.accountId === person.accountId}
            lead={personLead}
            label={person.name}
            onSelect={() => onPick({ kind: 'person', person })}
          />
        ))}
      </div>
    </>
  )
}
