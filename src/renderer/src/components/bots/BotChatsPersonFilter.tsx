// The Chats tab's person filter, at the search field's end: everyone, the owner's own chats, or one teammate's.
import { ListFilter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotChatPersonPick } from '../../../../shared/bots/bot-chat-people'
import {
  BotPersonPickItems,
  botPersonPickName,
  type BotPersonPickLabelled
} from './BotPersonPickItems'

export function BotChatsPersonFilter({
  entries,
  pick,
  onPick
}: {
  /** The viewer first (`useBotPersonPicks`). */
  entries: readonly BotPersonPickLabelled[]
  pick: BotChatPersonPick
  onPick: (pick: BotChatPersonPick) => void
}): React.JSX.Element {
  const t = useTranslate()
  const on = pick.kind !== 'everyone'
  const label = t('bots.chats.filter.label', 'Filter by person')
  const named = botPersonPickName(pick, entries)
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
        <BotPersonPickItems entries={entries} pick={pick} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
