import React from 'react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { startBotGroupThread } from '@/lib/bot-group-catalog'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { botGroupTabFaces } from '../../../../shared/bots/bot-group-face-layout'
import { BotGroupFaces } from './BotGroupFaces'
import { botErrorMessage } from './bot-presentation'

/** The + menu's first item in a group's home, as New Home Chat leads a bot's: a new thread. */
export function BotGroupNewThreadMenuItems({ group }: { group: BotGroup }): React.JSX.Element {
  const t = useTranslate()
  const bots = useBots()
  const members = group.members.flatMap(
    (member) => bots.find((bot) => bot.id === member.botId && bot.hostId === group.hostId) ?? []
  )
  return (
    <DropdownMenuItem
      variant="create"
      onSelect={() =>
        void startBotGroupThread(group).catch((error: unknown) =>
          toast.error(botErrorMessage(error))
        )
      }
    >
      <BotGroupFaces
        faces={botGroupTabFaces(members, (bot) => bot.id)}
        className={members.length > 1 ? 'h-3 w-5' : 'size-3'}
      />
      <span className="min-w-0 flex-1 truncate">
        {t('bots.groups.newThread', 'New thread in {{name}}', { name: group.name })}
      </span>
      <span className="font-normal text-muted-foreground">
        {t('bots.groups.newThreadHint', 'starts fresh')}
      </span>
    </DropdownMenuItem>
  )
}
