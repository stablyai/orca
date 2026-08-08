import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RoomData } from './use-room-data'

export function RoomSettingsDialog({
  data,
  open,
  onOpenChange
}: {
  data: RoomData
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const room = data.snapshot?.room
  const [roomName, setRoomName] = useState(room?.name ?? '')
  const [description, setDescription] = useState(room?.description ?? '')
  const [loopLimit, setLoopLimit] = useState(room?.loopLimit ?? 0)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if (!room || !roomName.trim()) {
      return
    }
    setSaving(true)
    try {
      await roomRpc(data.target, 'rooms.update', {
        roomId: room.id,
        name: roomName.trim(),
        description,
        loopLimit
      })
      onOpenChange(false)
      toast.success(translate('rooms.settings.saved', 'Room settings saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-sleek sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{translate('rooms.settings.title', 'Room settings')}</DialogTitle>
          <DialogDescription>
            {translate('rooms.settings.description', 'Room identity, context, and behavior.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {translate('rooms.common.room', 'Room')}
            </h3>
            <Field label={translate('rooms.common.name', 'Name')}>
              <Input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
            </Field>
            <Field label={translate('rooms.common.description', 'Description')}>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                className="w-full resize-y rounded-md border border-input bg-input/30 px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </Field>
            <Field
              label={translate('rooms.settings.loopLimit', 'Agent reply loop limit (0 = off)')}
            >
              <Input
                type="number"
                min={0}
                max={20}
                value={loopLimit}
                onChange={(event) => setLoopLimit(Number(event.target.value))}
              />
            </Field>
          </section>
        </div>
        <DialogFooter showCloseButton>
          <Button disabled={saving || !roomName.trim()} onClick={() => void save()}>
            {translate('rooms.common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  )
}
