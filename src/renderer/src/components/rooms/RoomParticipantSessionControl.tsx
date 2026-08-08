import { useState } from 'react'
import { Pause } from 'lucide-react'
import { cn } from '@/lib/utils'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import { AgentSessionControls } from '../agent-session-controls/AgentSessionControls'
import type { RoomData } from './use-room-data'
import { useRoomParticipantSessionOptions } from './use-room-participant-session-options'

export function isRoomParticipantSessionControlBusy(
  state: NonNullable<RoomData['snapshot']>['participants'][number]['state'],
  compacting: boolean
): boolean {
  return state === 'busy' || state === 'starting' || compacting
}

export function RoomParticipantSessionControl(props: {
  participant: NonNullable<RoomData['snapshot']>['participants'][number]
  target: RoomData['target']
  archived: boolean
}): React.JSX.Element {
  const { participant, target, archived } = props
  const [compacting, setCompacting] = useState(false)
  const { surface, snapshot } = useRoomParticipantSessionOptions(participant, target)
  const compact = async (): Promise<void> => {
    setCompacting(true)
    try {
      await roomRpc(target, 'rooms.participants.compact', { participantId: participant.id })
    } finally {
      setCompacting(false)
    }
  }

  return (
    <AgentSessionControls
      surface={surface}
      snapshot={snapshot}
      isWorking={isRoomParticipantSessionControlBusy(participant.state, compacting)}
      context={participant.context}
      canCompact={!archived}
      onCompact={compact}
      className={cn(
        'h-9 max-w-80 rounded-md border border-border bg-card px-2',
        participant.participation === 'paused' && 'opacity-60'
      )}
      leading={
        <>
          {participant.participation === 'paused' ? (
            <Pause className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                participant.state === 'busy' || participant.state === 'starting'
                  ? 'animate-pulse bg-primary'
                  : participant.state === 'online'
                    ? 'bg-muted-foreground/60'
                    : participant.state === 'error'
                      ? 'bg-destructive'
                      : 'bg-muted-foreground/40'
              )}
            />
          )}
          <span className="truncate font-medium text-foreground">@{participant.identity}</span>
        </>
      }
    />
  )
}
