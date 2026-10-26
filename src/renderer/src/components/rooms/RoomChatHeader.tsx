import { ArrowLeft, EllipsisVertical, Settings2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { Room, RoomMember } from './room-types'
import { RoomMemberAvatar } from './RoomMemberAvatar'

/** Chat-first header; setup and destructive actions stay in a quiet menu. */
export function RoomChatHeader(props: {
  selected: Room
  adminName: string | null
  directMember: RoomMember | null
  onExitDirect: () => void
  onOpenMembers: () => void
  onDelete: () => void
}) {
  useTranslation()
  const { selected, adminName, directMember } = props
  const isHome = selected.name === 'Orca HQ'

  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        {directMember ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onExitDirect}
            aria-label={translate('auto.components.rooms.page.backToRoom', 'Back to room')}
          >
            <ArrowLeft />
          </Button>
        ) : null}
        <RoomMemberAvatar
          member={
            directMember
              ? { ...directMember }
              : {
                  name: adminName ?? selected.name,
                  isAdmin: Boolean(adminName)
                }
          }
        />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold">
            <span className="truncate">
              {directMember
                ? directMember.name
                : isHome
                  ? (adminName ?? selected.name)
                  : selected.name}
            </span>
            {!directMember && isHome && adminName ? (
              <span className="rounded-full border border-annotation-highlight/50 bg-annotation-highlight/10 px-1.5 py-px text-2xs text-annotation-highlight dark:text-annotation-highlight">
                {translate('auto.components.rooms.page.adminRole', 'Admin')}
              </span>
            ) : null}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {directMember
              ? translate('auto.components.rooms.page.directRoomHint', 'Focused chat in {{room}}', {
                  room: selected.name
                })
              : isHome
                ? translate(
                    'auto.components.rooms.page.homeHint',
                    'Ask in plain language to create bots or group chats'
                  )
                : adminName
                  ? translate('auto.components.rooms.page.adminLeads', '{{name}} leads this team', {
                      name: adminName
                    })
                  : translate('auto.components.rooms.page.memberCountOnly', '{{count}} members', {
                      count: selected.members.length
                    })}
          </div>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={translate('auto.components.rooms.page.actions', 'Room actions')}
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={props.onOpenMembers}>
            <Settings2 />
            {translate('auto.components.rooms.page.manageMembers', 'Manage members')}
          </DropdownMenuItem>
          {!isHome ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={props.onDelete}>
                <Trash2 />
                {translate('auto.components.rooms.page.deleteRoom', 'Delete room')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
