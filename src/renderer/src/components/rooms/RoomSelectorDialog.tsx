import { useEffect, useState } from 'react'
import { Archive, Check, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { Room, RoomSnapshot } from '../../../../shared/rooms'
import { showRoomActionError } from './room-action-error'

export function RoomSelectorDialog({
  activeRoomId,
  groupId,
  onOpenChange,
  open,
  projectId,
  target,
  worktreeId
}: {
  activeRoomId: string | null
  groupId: string
  onOpenChange: (open: boolean) => void
  open: boolean
  projectId: string
  target: RuntimeClientTarget
  worktreeId: string
}): React.JSX.Element {
  const [rooms, setRooms] = useState<Room[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let disposed = false
    setLoading(true)
    setError(null)
    void roomRpc<{ rooms: Room[] }>(target, 'rooms.list', {
      projectId,
      includeArchived: true
    }).then(
      ({ rooms: listed }) => {
        if (!disposed) {
          setRooms(listed.filter((room) => room.worktreeId === worktreeId))
          setLoading(false)
        }
      },
      (cause) => {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setLoading(false)
        }
      }
    )
    return () => {
      disposed = true
    }
  }, [open, projectId, target, worktreeId])

  const openRoom = (room: Room): void => {
    const state = useAppStore.getState()
    const existing = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'room' && tab.entityId === room.id
    )
    const tab =
      existing ??
      state.createUnifiedTab(worktreeId, 'room', {
        entityId: room.id,
        label: room.name,
        targetGroupId: groupId
      })
    state.activateTab(tab.id, { worktreeId })
    onOpenChange(false)
  }

  const create = async (): Promise<void> => {
    if (!name.trim() || creating) {
      return
    }
    setCreating(true)
    try {
      const { snapshot } = await roomRpc<{ snapshot: RoomSnapshot }>(target, 'rooms.create', {
        projectId,
        worktreeId,
        name: name.trim(),
        userIdentity: 'user',
        userDisplayName: 'You'
      })
      setName('')
      openRoom(snapshot.room)
    } catch (cause) {
      showRoomActionError(cause)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(82vh,44rem)] min-w-0 flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{translate('rooms.selector.title', 'Choose a room')}</DialogTitle>
          <DialogDescription>
            {translate(
              'rooms.selector.description',
              'Open or create a room for the current worktree.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-2 overflow-y-auto pr-1 scrollbar-sleek">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {translate('rooms.common.loading', 'Loading…')}
            </p>
          ) : error ? (
            <p className="py-8 text-center text-sm text-destructive">{error}</p>
          ) : rooms.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {translate('rooms.page.empty', 'No rooms yet')}
            </p>
          ) : (
            rooms.map((room) => {
              const selected = room.id === activeRoomId
              return (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => openRoom(room)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                    selected
                      ? 'border-primary/50 bg-accent'
                      : 'border-border hover:border-foreground/30 hover:bg-accent/40'
                  )}
                >
                  <Check className={cn('mt-0.5 size-4 shrink-0', !selected && 'invisible')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{room.name}</span>
                      {room.archivedAt ? (
                        <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          <Archive className="size-3" />
                          {translate('rooms.common.archived', 'Archived')}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {room.description ||
                        translate('rooms.header.defaultTopic', 'Multi-agent room')}
                    </p>
                  </div>
                </button>
              )
            })
          )}
        </div>
        <form
          className="flex gap-2 border-t border-border pt-4"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={translate('rooms.selector.newRoom', 'New room name')}
          />
          <Button type="submit" disabled={!name.trim() || creating}>
            <Plus />
            {translate('rooms.page.create', 'Create room')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
