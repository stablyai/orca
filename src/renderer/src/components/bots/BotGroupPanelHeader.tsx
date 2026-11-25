// The top of a group's Items tab, in a bot header's shape: the group's own picture (its sidebar row's
// faces) opening its member list, its name, a counts-only line, then the filter, gear and more.
import { useState } from 'react'
import { MoreHorizontal, Settings, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useAppStore } from '@/store'
import { selectFolderWorkspaceOnHost } from '@/store/folder-workspaces/folder-workspace-record-index'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { BOT_GROUP_FACE_SLOT, botGroupFaces } from '../../../../shared/bots/bot-group-face-layout'
import { BotAvatar } from './BotAvatar'
import { BotGroupFaces } from './BotGroupFaces'
import { BotGroupMembersDialog } from './BotGroupMembersDialog'
import { botQuietLine } from './BotPanelHeader'
import { BotPanelHostLine } from './BotPanelHostLine'
import { BotRowLineText, useBotRowLine } from './BotRowActivityLine'
import { useBotGroupDelete } from './use-bot-group-delete'
import { botHomeHostId } from '../../../../shared/bots/bot-home-host'

/** The header's picture slot, a bot header's `size-9`. */
const PICTURE = 36
/** Members the menu lists before it scrolls. */
const MENU_ROWS = 6
/** Names the picture's label lists before "and N more". */
const NAMED = 3

function MemberRow({ bot }: { bot: Bot }): React.JSX.Element {
  const home = useAppStore((state) =>
    selectFolderWorkspaceOnHost(state, bot.folderWorkspaceId, botHomeHostId(bot))
  )
  return (
    <DropdownMenuItem onSelect={() => void openBotHomeTab(bot)}>
      <BotAvatar bot={bot} className="size-7 shrink-0 rounded-full text-sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-5">{bot.name}</span>
        <span className="block truncate text-xs leading-4 text-muted-foreground">
          {home ? <MemberLine bot={bot} home={home} /> : null}
        </span>
      </span>
    </DropdownMenuItem>
  )
}

/** The member's sidebar line, which says when it waits on you, works or is paused. */
function MemberLine({
  bot,
  home
}: {
  bot: Bot
  home: NonNullable<ReturnType<typeof selectFolderWorkspaceOnHost>>
}): React.JSX.Element | null {
  const { line, limit, now } = useBotRowLine(bot, home)
  return line || limit ? <BotRowLineText line={line} limit={limit} now={now} /> : null
}

export function BotGroupPanelHeader({
  group,
  members,
  needsYou,
  working,
  next,
  now,
  filter
}: {
  group: BotGroup
  members: readonly Bot[]
  /** Every member's whole Needs you, as each one's own tab counts it. */
  needsYou: number
  working: number
  /** The members' soonest run, said while nothing waits or works. */
  next: { bot: Bot; at: number } | null
  now: number
  filter: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  // The group's own server, so an empty room still says it is down.
  const offline = useBotHostOffline(group.hostId)
  const [managing, setManaging] = useState(false)
  const deleteGroup = useBotGroupDelete()
  const names = members.slice(0, NAMED).map((bot) => bot.name)
  const membersLabel =
    members.length > NAMED
      ? t('bots.groups.panel.membersMore', 'Members: {{names}} and {{count}} more', {
          names: names.join(', '),
          count: members.length - NAMED
        })
      : t('bots.groups.panel.membersNamed', 'Members: {{names}}', { names: names.join(', ') })
  const settingsLabel = t('bots.groups.panel.settings', 'Group settings…')
  const moreLabel = t('bots.panel.more', 'More')
  const needs = t('bots.connectors.needYou', '{{count}} need you', {
    count: needsYou,
    defaultValue_one: '{{count}} needs you'
  })
  const workingText = t('sidebar.agentSummary.stateCount.working', '{{count}} working', {
    count: working,
    defaultValue_one: '{{count}} working'
  })
  const idle = botQuietLine(
    { running: null, next: next ? { name: next.bot.name, at: next.at } : null },
    now
  )
  const line = (compact: boolean): React.ReactNode =>
    needsYou > 0 || working > 0 ? (
      <>
        {needsYou > 0 ? needs : null}
        {needsYou > 0 && working > 0 ? (
          <span className="@max-[284px]:hidden">{` · ${workingText}`}</span>
        ) : working > 0 ? (
          workingText
        ) : null}
      </>
    ) : idle.short === null || compact ? (
      (idle.short ?? idle.text)
    ) : (
      <>
        <span className="@max-[284px]:hidden">{idle.text}</span>
        <span className="hidden @max-[284px]:inline">{idle.short}</span>
      </>
    )
  const fullLine =
    needsYou > 0 && working > 0
      ? `${needs} · ${workingText}`
      : needsYou > 0
        ? needs
        : working > 0
          ? workingText
          : idle.text
  return (
    <div className="flex items-center gap-2.5 px-2 pb-1 pt-1 @max-[284px]:gap-1.5">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={membersLabel}
                className="relative size-9 shrink-0 rounded-[9px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:ring-1 data-[state=open]:ring-ring"
              >
                {members.length > 0 ? (
                  <BotGroupFaces
                    faces={botGroupFaces(members, (bot) => bot.id, PICTURE / BOT_GROUP_FACE_SLOT)}
                    className="size-9"
                  />
                ) : (
                  <span className="flex size-9 items-center justify-center rounded-full border border-dashed border-input text-muted-foreground">
                    <Users className="size-4" />
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" sideOffset={4}>
            {t('bots.groups.panel.members', 'Members')}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>
            {t('bots.groups.panel.membersCount', 'Members {{count}}', { count: members.length })}
          </DropdownMenuLabel>
          <div
            className="scrollbar-sleek overflow-y-auto"
            style={{ maxHeight: `${MENU_ROWS * 2.75}rem` }}
          >
            {members.map((bot) => (
              <MemberRow key={bot.id} bot={bot} />
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold leading-5">{group.name}</div>
        <BotPanelHostLine hostId={group.hostId} offline={offline} title={fullLine}>
          {(compact) =>
            members.length > 0
              ? line(compact)
              : t('bots.groups.panel.noMembers', 'No bots in this group')
          }
        </BotPanelHostLine>
      </div>
      {filter}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={settingsLabel}
            onClick={() => setManaging(true)}
          >
            <Settings />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {settingsLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={moreLabel}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {moreLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setManaging(true)}>
            <Users />
            {t('bots.groups.manageMembersMenu', 'Manage members…')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => void deleteGroup(group)}>
            <Trash2 />
            {t('bots.groups.deleteGroupMenu', 'Delete group…')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {managing ? <BotGroupMembersDialog group={group} onClose={() => setManaging(false)} /> : null}
    </div>
  )
}
