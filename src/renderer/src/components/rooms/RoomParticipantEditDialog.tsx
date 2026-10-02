import { useState } from 'react'
import { Loader2 } from 'lucide-react'
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
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RoomParticipant } from '../../../../shared/rooms'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { showRoomActionError } from './room-action-error'

export function RoomParticipantEditDialog({
  participant,
  target,
  onOpenChange
}: {
  participant: RoomParticipant | null
  target: RuntimeClientTarget
  onOpenChange: (open: boolean) => void
}): React.JSX.Element | null {
  if (!participant) {
    return null
  }
  return (
    <RoomParticipantEditor
      key={participant.id}
      participant={participant}
      target={target}
      onOpenChange={onOpenChange}
    />
  )
}

function RoomParticipantEditor({
  participant,
  target,
  onOpenChange
}: {
  participant: RoomParticipant
  target: RuntimeClientTarget
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [displayName, setDisplayName] = useState(participant.displayName)
  const [identity, setIdentity] = useState(participant.identity)
  const [saving, setSaving] = useState(false)
  const normalizedName = displayName.trim()
  const normalizedIdentity = identity.trim()
  const unchanged =
    normalizedName === participant.displayName && normalizedIdentity === participant.identity

  const save = async (): Promise<void> => {
    if (!normalizedName || !normalizedIdentity || unchanged) {
      return
    }
    setSaving(true)
    try {
      await roomRpc(target, 'rooms.participants.update', {
        participantId: participant.id,
        displayName: normalizedName,
        identity: normalizedIdentity
      })
      onOpenChange(false)
    } catch (error) {
      showRoomActionError(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {translate('rooms.people.editParticipant', 'Edit participant')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'rooms.people.editParticipantDescription',
                'The new name and @identity apply to the next room delivery.'
              )}
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {translate('rooms.people.displayName', 'Display name')}
            <Input
              autoFocus
              value={displayName}
              maxLength={120}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {translate('rooms.people.identity', 'Identity')}
            <Input
              value={identity}
              maxLength={80}
              onChange={(event) => setIdentity(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {translate('rooms.common.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              disabled={saving || !normalizedName || !normalizedIdentity || unchanged}
              aria-label={saving ? translate('rooms.common.saving', 'Saving…') : undefined}
            >
              {saving ? (
                <Loader2 className="animate-spin" />
              ) : (
                translate('rooms.common.save', 'Save')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
