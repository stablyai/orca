// The Chats tab's person filter, at the search field's end: everyone, the owner's own chats, or one teammate's.
import { Check, ListFilter, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatPerson } from '../../../../shared/bots/bot-chat-tree'
import type { BotChatPersonPick } from '../../../../shared/bots/bot-chat-people'
import { BotOwnerAvatar } from './bot-connector-people'

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

export function BotChatsPersonFilter({
  bot,
  people,
  pick,
  onPick
}: {
  bot: Bot
  people: readonly BotChatPerson[]
  pick: BotChatPersonPick
  onPick: (pick: BotChatPersonPick) => void
}): React.JSX.Element {
  const t = useTranslate()
  const account = useBotHostOrcaAccount(bot.hostId)
  const ownName =
    account?.state === 'signed-in' ? (account.displayName ?? account.email ?? null) : null
  const you = ownName
    ? t('bots.teamShare.you', '{{name}} (you)', { name: ownName })
    : t('bots.chats.filter.you', 'You')
  const on = pick.kind !== 'everyone'
  const label = t('bots.chats.filter.label', 'Filter by person')
  const named = pick.kind === 'person' ? pick.person.name : pick.kind === 'owner' ? you : null
  const fullLabel = named ? `${label} · ${named}` : label
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="muted-field-icon"
              size="icon-xs"
              aria-label={fullLabel}
              className="absolute top-1/2 right-0.5 size-5.5 -translate-y-1/2"
            >
              <ListFilter className={cn('size-3.5', on && 'text-foreground')} />
              {on ? (
                <span
                  aria-hidden
                  className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-foreground"
                />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {fullLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
