import React from 'react'
import { Bot as BotIcon, Download, LayoutTemplate, Link2, Plus, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { openBotShareLink } from './sharing/bot-share-receive-open'
import { openBotTemplates } from './templates/bot-templates-open'

// The + menu's rows only: 28px tall (a 20px line in the item's own 4px padding), roomier than other menus.
const BOT_MENU_ROW = 'flex min-h-5 items-center gap-2'

export function BotSidebarNewMenu({
  open,
  onOpenChange,
  canCreateGroup,
  onNewBot,
  onImport,
  onNewGroup
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  canCreateGroup: boolean
  onNewBot: () => void
  onImport: () => void
  onNewGroup: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const newBotLabel = t('bots.section.newBot', 'New bot')
  const newLabel = t('bots.section.new', 'New bot or group')
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label={newLabel}
            >
              <Plus className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {newLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="bottom" align="start" sideOffset={6}>
        {/* New bot opens its dialog on click or Enter; hover or › shows the other ways to add one. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            onClick={(event) => {
              event.preventDefault()
              onNewBot()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onNewBot()
              }
            }}
          >
            <span className={BOT_MENU_ROW}>
              <BotIcon className="size-3.5" />
              {newBotLabel}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={onNewBot}>
              <span className={BOT_MENU_ROW}>
                <Plus className="size-3.5" />
                {t('bots.section.startFromScratch', 'Start from scratch')}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openBotTemplates()}>
              <span className={BOT_MENU_ROW}>
                <LayoutTemplate className="size-3.5" />
                {t('bots.templates.browse', 'Browse templates')}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openBotShareLink(null)}>
              <span className={BOT_MENU_ROW}>
                <Link2 className="size-3.5" />
                {t('bots.share.receive.fromLinkMenu', 'From a link…')}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onImport}>
              <span className={BOT_MENU_ROW}>
                <Download className="size-3.5" />
                {t('bots.import.menu', 'Import from another app…')}
              </span>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {/* A group needs two bots to talk to each other. */}
        <DropdownMenuItem disabled={!canCreateGroup} onSelect={onNewGroup}>
          <span className={BOT_MENU_ROW}>
            <Users className="size-3.5" />
            {t('bots.groups.newGroup', 'New group')}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
