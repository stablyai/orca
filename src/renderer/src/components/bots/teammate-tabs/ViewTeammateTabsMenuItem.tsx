// An agent row's right-click way into the same view as the tab row's avatar menu: a teammate's tabs.
import { Users } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { ConnectorAvatar } from '@/components/ConnectorAvatar'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { useTabListPeople } from './tab-list-people'
import { viewTabList } from './viewed-tab-list'

/** Mounted only while the menu is open; nothing for an agent shared with no one. */
export function ViewTeammateTabsMenuItem({
  bot,
  openHome
}: {
  bot: Bot
  /** Opens the agent's Home; false when it can't open yet. */
  openHome: () => boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const people = useTabListPeople(bot)
  if (!people || people.others.length === 0) {
    return null
  }
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger className="whitespace-nowrap">
          <Users className="size-3.5" />
          {t('bots.teammateTabs.rowEntry', 'View teammate’s tabs')}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-58">
          <div className="scrollbar-sleek max-h-[15rem] overflow-y-auto">
            {people.others.map((entry) => (
              <ContextMenuItem
                key={entry.person === 'owner' ? 'owner' : entry.person.accountId}
                onSelect={() => {
                  if (openHome()) {
                    viewTabList(folderWorkspaceKey(bot.folderWorkspaceId), entry.person)
                  }
                }}
              >
                <ConnectorAvatar avatarUrl={null} name={entry.name} className="size-5 text-[8px]" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </ContextMenuItem>
            ))}
          </div>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
    </>
  )
}
