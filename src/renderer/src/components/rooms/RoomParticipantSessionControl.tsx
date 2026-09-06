import { useState } from 'react'
import { Pause } from 'lucide-react'
import {
  getAgentSessionOptionCatalog,
  normalizeClaudeModelId
} from '../../../../shared/agent-session-option-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import { AgentSessionControls } from '../agent-session-controls/AgentSessionControls'
import { nativeChatSessionChoiceLabel } from '../native-chat/native-chat-session-option-labels'
import type { RoomData } from './use-room-data'
import { useRoomParticipantSessionOptions } from './use-room-participant-session-options'
import { showRoomActionError } from './room-action-error'

export function isRoomParticipantSessionControlBusy(
  state: NonNullable<RoomData['snapshot']>['participants'][number]['state'],
  compacting: boolean
): boolean {
  return state === 'busy' || state === 'starting' || compacting
}

export function RoomParticipantSessionControl(props: {
  participant: NonNullable<RoomData['snapshot']>['participants'][number]
  target: RoomData['target']
}): React.JSX.Element {
  const { participant, target } = props
  const [compacting, setCompacting] = useState(false)
  const { surface, snapshot, canCompact, refreshMachineOptions } = useRoomParticipantSessionOptions(
    participant,
    target
  )
  const savedModel = participant.context.model?.trim()
  const persistedModel =
    savedModel && (participant.agent === 'claude' || participant.agent === 'openclaude')
      ? normalizeClaudeModelId(savedModel)
      : savedModel
  const catalog = participant.agent
    ? getAgentSessionOptionCatalog(
        participant.agent === 'openclaude' ? 'claude' : participant.agent
      )
    : null
  const fallbackModelLabel = persistedModel
    ? (catalog?.models.find(({ id }) => id === persistedModel)?.label ?? savedModel)
    : null
  const fallbackOptionLabel = [
    participant.context.effort
      ? nativeChatSessionChoiceLabel({
          value: participant.context.effort,
          label: participant.context.effort
        })
      : null,
    participant.context.fastMode === true
      ? translate('components.native-chat.composer.optionValue.fast', 'Fast')
      : null
  ]
    .filter((label): label is string => Boolean(label))
    .join(' · ')
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
      canCompact={canCompact}
      onCompact={compact}
      onOpen={() => {
        if (participant.providerSession?.transport === 'machine' && !surface) {
          void roomRpc(target, 'rooms.participants.wake', { participantId: participant.id })
            .then(refreshMachineOptions)
            .catch(showRoomActionError)
        }
      }}
      fallbackModelLabel={fallbackModelLabel}
      fallbackOptionLabel={fallbackOptionLabel || null}
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
