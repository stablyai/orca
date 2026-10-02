import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import { RoomPanelEmpty, RoomPanelSection } from './RoomPanelSection'
import type { RoomData } from './use-room-data'
import { showRoomActionError } from './room-action-error'

export function PinsPanel({ data }: { data: RoomData }): React.JSX.Element {
  const pins = data.snapshot?.pins ?? []
  return (
    <RoomPanelSection title={translate('rooms.inspector.pins', 'Pins')}>
      {pins.length === 0 ? (
        <RoomPanelEmpty label={translate('rooms.pins.empty', 'No pinned messages')} />
      ) : (
        pins.map((pin) => {
          const message = data.messages.find((item) => item.id === pin.messageId)
          return (
            <div key={pin.messageId} className="rounded-md border border-border p-2 text-xs">
              <p className="line-clamp-4">
                {message?.body || translate('rooms.pins.fallback', 'Pinned message')}
              </p>
              <div className="mt-2 flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void roomRpc(data.target, 'rooms.pins.set', {
                      roomId: pin.roomId,
                      messageId: pin.messageId,
                      status: pin.status === 'todo' ? 'done' : 'todo'
                    }).catch(showRoomActionError)
                  }
                >
                  {pin.status === 'todo'
                    ? translate('rooms.pins.done', 'Done')
                    : translate('rooms.pins.reopen', 'Reopen')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void roomRpc(data.target, 'rooms.pins.remove', {
                      roomId: pin.roomId,
                      messageId: pin.messageId
                    }).catch(showRoomActionError)
                  }
                >
                  {translate('rooms.common.remove', 'Remove')}
                </Button>
              </div>
            </div>
          )
        })
      )}
    </RoomPanelSection>
  )
}
