import {
  Crown,
  CircleAlert,
  ArrowLeft,
  EllipsisVertical as EllipsisIcon,
  Loader2,
  RefreshCw,
  SendHorizontal,
  Users
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { Room, RoomMember } from './room-types'
import { CreateRoomDialog } from './CreateRoomDialog'
import { RoomMemberAvatar } from './RoomMemberAvatar'

type SidebarProps = {
  rooms: Room[]
  loading: boolean
  selectedId: string | null
  workingIds: ReadonlySet<string>
  waitingIds: ReadonlySet<string>
  unreadIds: ReadonlySet<string>
  onSelect: (id: string) => void
  directMemberId: string | null
  onSelectMember: (memberId: string | null) => void
  onRefresh: () => void
  onCreated: () => void
}

function roomSubtitle(room: Room): string {
  const latest = room.latestLine
  if (latest?.text.trim()) {
    const speaker = latest.memberId
      ? latest.who
      : translate('auto.components.rooms.sidebar.you', 'You')
    return `${speaker}: ${latest.text.replace(/\s+/g, ' ').trim()}`
  }
  const admin = room.members.find((member) => member.isAdmin)?.name
  if (room.name === 'Orca HQ') {
    return admin
      ? translate('auto.components.rooms.sidebar.chiefReady', 'Ready — ask it to build a team')
      : translate('auto.components.rooms.sidebar.chiefStarting', 'Starting the chief…')
  }
  return (
    room.notice ||
    room.members
      .map((member) => member.name)
      .slice(0, 3)
      .join(' · ') ||
    translate('auto.components.rooms.sidebar.emptyTeam', 'No members yet')
  )
}

/** ds_bot-like people list: the chief is first, teams stay one click away. */
export function RoomSidebar(props: SidebarProps) {
  useTranslation()
  const closeRoomsPage = useAppStore((state) => state.closeRoomsPage)
  const home = props.rooms.find((room) => room.name === 'Orca HQ')
  const teams = props.rooms
    .filter((room) => room.id !== home?.id)
    .sort((left, right) => left.name.localeCompare(right.name))
  const renderRoom = (room: Room, isHome: boolean) => {
    const active = props.selectedId === room.id

    const renderMember = (member: RoomMember) => {
      const direct = props.directMemberId === member.memberId
      return (
        <button
          key={member.memberId}
          type="button"
          data-current={direct}
          onClick={() => props.onSelectMember(direct ? null : member.memberId)}
          className={cn(
            'ml-6 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            direct && 'bg-accent text-accent-foreground'
          )}
        >
          <RoomMemberAvatar member={member} className="size-6 [&_svg]:size-3" />
          <span className="min-w-0 flex-1 truncate text-sm">{member.name}</span>
          {member.status === 'working' ? (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
          ) : member.status === 'waiting' ? (
            <CircleAlert className="size-3 shrink-0 text-status-warning" />
          ) : (
            <SendHorizontal
              className={cn(
                'size-3 shrink-0 text-muted-foreground/50',
                direct && 'text-muted-foreground'
              )}
            />
          )}
        </button>
      )
    }

    return (
      <div key={room.id} className="space-y-1">
        <button
          type="button"
          data-current={active}
          onClick={() => props.onSelect(room.id)}
          className={cn(
            'flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            active && 'bg-accent text-accent-foreground'
          )}
        >
          {isHome ? (
            <RoomMemberAvatar
              member={{
                name: room.members.find((member) => member.isAdmin)?.name ?? room.name,
                isAdmin: true
              }}
            />
          ) : (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-secondary text-secondary-foreground">
              <Users className="size-3.5" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <span className="truncate">
                {isHome
                  ? (room.members.find((member) => member.isAdmin)?.name ?? room.name)
                  : room.name}
              </span>
              {isHome ? (
                <Crown className="size-3 shrink-0 text-annotation-highlight dark:text-annotation-highlight" />
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {props.waitingIds.has(room.id) ? (
                <span className="inline-flex items-center gap-1 text-status-warning">
                  <CircleAlert className="size-3" />
                  {translate('auto.components.rooms.sidebar.waiting', 'Waiting approval…')}
                </span>
              ) : props.workingIds.has(room.id) ? (
                <span className="inline-flex items-center gap-1 animate-pulse">
                  <Loader2 className="size-3 animate-spin" />
                  {translate('auto.components.rooms.sidebar.working', 'Working…')}
                </span>
              ) : (
                roomSubtitle(room)
              )}
            </span>
          </span>
          {props.unreadIds.has(room.id) && !active ? (
            <span aria-hidden className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
          ) : null}
        </button>
        {active ? (
          room.members.length > 0 ? (
            <div className="space-y-1">{room.members.map(renderMember)}</div>
          ) : (
            <p className="ml-6 px-2 text-xs text-muted-foreground">
              {translate('auto.components.rooms.sidebar.noMembers', 'No members yet')}
            </p>
          )
        ) : null}
      </div>
    )
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col overflow-hidden border-r border-border/60 bg-card/20">
      <div className="flex items-center justify-between gap-1 border-b border-border/60 px-2 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={closeRoomsPage}
          aria-label={translate('auto.components.rooms.page.backToApp', 'Back to app')}
        >
          <ArrowLeft />
          {translate('auto.components.rooms.page.backToApp', 'Back to app')}
        </Button>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <CreateRoomDialog onCreated={props.onCreated} variant="icon" />
            </TooltipTrigger>
            <TooltipContent>
              {translate('auto.components.rooms.createRoom.newRoom', 'New group')}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={translate('auto.components.rooms.sidebar.more', 'More actions')}
              >
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={props.onRefresh}>
                <RefreshCw />
                {translate('auto.components.rooms.page.refresh', 'Refresh')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-4 p-2">
          {props.loading ? (
            <div className="flex items-center gap-2 px-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {translate('auto.components.rooms.page.loading', 'Loading…')}
            </div>
          ) : (
            <>
              {home ? (
                <section>
                  <h2 className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {translate('auto.components.rooms.sidebar.chief', 'Chief')}
                  </h2>
                  <div className="space-y-1">{renderRoom(home, true)}</div>
                </section>
              ) : null}
              <section>
                <h2 className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {translate('auto.components.rooms.sidebar.teams', 'Teams')}
                </h2>
                {teams.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    {translate(
                      'auto.components.rooms.sidebar.noTeams',
                      'Ask the chief to create one.'
                    )}
                  </p>
                ) : (
                  <div className="space-y-1">{teams.map((room) => renderRoom(room, false))}</div>
                )}
              </section>
            </>
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}
