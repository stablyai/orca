import { useState } from 'react'
import { Ellipsis, MessageSquare, Pause, Pencil, Play, Plus, Terminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RoomRole } from '../../../../shared/rooms'
import { RoomPanelEmpty, RoomPanelSection } from './RoomPanelSection'
import type { RoomData } from './use-room-data'
import { showRoomActionError } from './room-action-error'

export function PeoplePanel({
  data,
  onAddAgent
}: {
  data: RoomData
  onAddAgent: () => void
}): React.JSX.Element {
  const snapshot = data.snapshot
  const [editing, setEditing] = useState<RoomRole | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  if (!snapshot) {
    return <RoomPanelEmpty />
  }

  const beginRole = (role?: RoomRole): void => {
    setEditorOpen(true)
    setEditing(role ?? null)
    setName(role?.name ?? '')
    setPrompt(role?.prompt ?? '')
  }
  const closeEditor = (): void => {
    setEditing(null)
    setEditorOpen(false)
    setName('')
    setPrompt('')
  }
  const saveRole = async (): Promise<void> => {
    if (!name.trim()) {
      return
    }
    await roomRpc(data.target, 'rooms.roles.save', {
      roleId: editing?.id,
      roomId: snapshot.room.id,
      name: name.trim(),
      prompt
    })
    closeEditor()
  }
  const deleteRole = async (): Promise<void> => {
    if (!editing) {
      return
    }
    await roomRpc(data.target, 'rooms.roles.delete', { roleId: editing.id })
    closeEditor()
  }

  return (
    <div className="space-y-4">
      <RoomPanelSection
        title={translate('rooms.people.participants', 'Participants')}
        action={
          <Button size="sm" variant="outline" onClick={onAddAgent}>
            <Plus className="mr-1 size-3" /> {translate('rooms.common.agent', 'Agent')}
          </Button>
        }
      >
        {snapshot.participants.map((participant) => (
          <div key={participant.id} className="rounded-md border border-border p-2 text-xs">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 truncate">
                <b>@{participant.identity}</b>
                <br />
                <span className="text-muted-foreground">
                  {participant.actorKind === 'agent'
                    ? `${participant.agent} · ${participant.participation === 'paused' ? 'Paused' : roomParticipantStateLabel(participant.state)}`
                    : translate('rooms.people.you', 'You')}
                </span>
              </span>
              {participant.actorKind === 'agent' ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={translate(
                        'rooms.people.participantActions',
                        'Participant actions'
                      )}
                    >
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() =>
                        void roomRpc(data.target, 'rooms.participants.reveal', {
                          participantId: participant.id,
                          viewMode: 'chat'
                        }).catch(showRoomActionError)
                      }
                    >
                      <MessageSquare /> {translate('rooms.people.openChat', 'Open chat view')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        void roomRpc(data.target, 'rooms.participants.reveal', {
                          participantId: participant.id,
                          viewMode: 'terminal'
                        }).catch(showRoomActionError)
                      }
                    >
                      <Terminal /> {translate('rooms.people.openTerminal', 'Open terminal view')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        void roomRpc(data.target, 'rooms.participants.update', {
                          participantId: participant.id,
                          participation:
                            participant.participation === 'paused' ? 'active' : 'paused'
                        }).catch(showRoomActionError)
                      }
                    >
                      {participant.participation === 'paused' ? <Play /> : <Pause />}
                      {participant.participation === 'paused'
                        ? translate('rooms.people.resumeInRoom', 'Resume in room')
                        : translate('rooms.people.pauseInRoom', 'Pause in room')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() =>
                        void roomRpc(data.target, 'rooms.participants.remove', {
                          participantId: participant.id
                        }).catch(showRoomActionError)
                      }
                    >
                      {translate('rooms.people.stopAndRemove', 'Stop agent and remove')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
            {participant.actorKind === 'agent' ? (
              <select
                value={participant.roleId ?? ''}
                onChange={(event) =>
                  void roomRpc(data.target, 'rooms.participants.update', {
                    participantId: participant.id,
                    roleId: event.target.value || null
                  }).catch(showRoomActionError)
                }
                className="mt-2 w-full rounded border border-border bg-background p-1 text-xs"
                aria-label={translate('rooms.people.roleFor', 'Role for {{identity}}', {
                  identity: participant.identity
                })}
              >
                <option value="">{translate('rooms.people.noRole', 'No role')}</option>
                {snapshot.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        ))}
      </RoomPanelSection>
      <RoomPanelSection
        title={translate('rooms.people.roles', 'Roles')}
        action={
          <Button size="sm" variant="ghost" onClick={() => beginRole()}>
            <Plus className="mr-1 size-3" /> {translate('rooms.people.role', 'Role')}
          </Button>
        }
      >
        {snapshot.roles.map((role) => (
          <button
            key={role.id}
            type="button"
            className="w-full rounded-md border border-border p-2 text-left text-xs hover:border-foreground/30"
            onClick={() => beginRole(role)}
          >
            <div className="flex items-start gap-2">
              <b className="min-w-0 flex-1 truncate">{role.name}</b>
              <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
            </div>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
              {role.prompt || translate('rooms.people.noPrompt', 'No prompt')}
            </p>
          </button>
        ))}
      </RoomPanelSection>
      <Dialog open={editorOpen} onOpenChange={(open) => !open && closeEditor()}>
        <DialogContent className="min-w-0 sm:max-w-2xl">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void saveRole().catch(showRoomActionError)
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editing
                  ? translate('rooms.people.editRole', 'Edit role')
                  : translate('rooms.people.role', 'Role')}
              </DialogTitle>
              <DialogDescription>
                {translate('rooms.people.roleInstructions', 'Instructions for this role')}
              </DialogDescription>
            </DialogHeader>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={translate('rooms.people.roleName', 'Role name')}
            />
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={translate('rooms.people.roleInstructions', 'Instructions for this role')}
              className="min-h-56 w-full resize-y rounded-md border border-input bg-input/30 p-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <DialogFooter>
              {editing ? (
                <Button
                  type="button"
                  variant="destructive"
                  className="mr-auto"
                  onClick={() => void deleteRole().catch(showRoomActionError)}
                >
                  <Trash2 />
                  {translate('rooms.people.deleteRole', 'Delete role')}
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={closeEditor}>
                {translate('rooms.common.cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                {translate('rooms.common.save', 'Save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function roomParticipantStateLabel(state: string): string {
  return state === 'online' ? 'Ready' : state[0]!.toUpperCase() + state.slice(1)
}
