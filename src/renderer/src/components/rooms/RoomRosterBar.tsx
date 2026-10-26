import { CircleAlert, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import type { AgentSessionOption, Room } from './room-types'
import { shortSessionLabel } from './room-session-pool'
import { SpawnBotForm } from './SpawnBotForm'
import { RoomMemberAvatar, agentFromMemberId } from './RoomMemberAvatar'
import { RoomMemberModelPicker } from './RoomMemberModelPicker'

/** Member management lives off the chat surface so ordinary conversations stay clean. */
export function RoomRosterBar(props: {
  selected: Room
  open: boolean
  onOpenChange: (open: boolean) => void
  poolAvailable: AgentSessionOption[]
  worktreeNames: Map<string, string>
  onSpawned: () => void
  onAddMember: (sessionId: string, isAdmin: boolean) => void
  onRemoveMember: (memberId: string) => void
}) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const { selected } = props

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-[min(420px,92vw)]">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-sleek">
          <div className="border-b border-border/60">
            <SheetHeader>
              <SheetTitle>
                {translate('auto.components.rooms.roster.title', 'Team members')}
              </SheetTitle>
              <SheetDescription>
                {translate(
                  'auto.components.rooms.roster.description',
                  'Create a bot, turn an open session into a fresh bot, or clean up this team.'
                )}
              </SheetDescription>
            </SheetHeader>
          </div>

          <div className="space-y-3 p-4">
            <h3 className="text-xs font-semibold text-muted-foreground">
              {translate('auto.components.rooms.roster.current', 'Current members')}
            </h3>
            <div className="space-y-1">
              {selected.members.length === 0 ? (
                <p className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                  {translate('auto.components.rooms.page.noMembers', 'No members yet.')}
                </p>
              ) : (
                selected.members.map((m) => (
                  <div
                    key={m.memberId}
                    className="flex items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-2"
                  >
                    <RoomMemberAvatar
                      member={{ ...m, agent: agentFromMemberId(m.memberId) ?? undefined }}
                      className="size-5 [&_svg]:size-3"
                    />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{m.name}</span>
                      <RoomMemberModelPicker roomId={selected.id} member={m} />
                    </div>
                    {m.status === 'working' ? (
                      <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" />
                        {translate('auto.components.rooms.sidebar.working', 'Working…')}
                      </span>
                    ) : m.status === 'waiting' ? (
                      <span className="inline-flex items-center gap-1 text-2xs text-status-warning">
                        <CircleAlert className="size-3" />
                        {translate('auto.components.rooms.sidebar.waiting', 'Waiting approval…')}
                      </span>
                    ) : m.status === 'failed' ? (
                      <span className="inline-flex items-center gap-1 text-2xs text-destructive">
                        {translate('auto.components.rooms.page.memberFailed', 'Failed')}
                      </span>
                    ) : null}
                    {!m.isAdmin ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => props.onRemoveMember(m.memberId)}
                        aria-label={translate(
                          'auto.components.rooms.page.removeMember',
                          'Remove {{name}}',
                          {
                            name: m.name
                          }
                        )}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="p-4 pt-0">
            <SpawnBotForm
              roomId={selected.id}
              onSpawned={props.onSpawned}
              onCancel={() => props.onOpenChange(false)}
            />
          </div>

          <div className="space-y-2 p-4 pt-0">
            <h3 className="text-xs font-semibold text-muted-foreground">
              {translate('auto.components.rooms.page.addMember', 'Turn an open session into a bot')}
            </h3>
            <div className="max-h-56 space-y-1 overflow-y-auto scrollbar-sleek">
              {props.poolAvailable.length === 0 ? (
                <p className="text-xs text-muted-foreground/70">
                  {translate(
                    'auto.components.rooms.page.allSessionsAdded',
                    'Every open agent session is already represented here.'
                  )}
                </p>
              ) : (
                props.poolAvailable.map((opt) => (
                  <div
                    key={opt.sessionId}
                    className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{shortSessionLabel(opt.label)}</p>
                      <p className="truncate text-xs text-muted-foreground/70">
                        {props.worktreeNames.get(opt.worktreeId) ?? ''}
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => props.onAddMember(opt.sessionId, false)}
                    >
                      {translate('auto.components.rooms.page.add', 'Create')}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => props.onAddMember(opt.sessionId, true)}
                    >
                      {translate('auto.components.rooms.page.addAsAdmin', 'Admin')}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
