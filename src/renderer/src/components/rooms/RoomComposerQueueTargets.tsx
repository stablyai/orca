import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { RoomParticipant } from '../../../../shared/rooms'

export function RoomComposerQueueTargets({
  participants,
  value,
  onChange,
  disabled = false
}: {
  participants: RoomParticipant[]
  value: string[] | null
  onChange: (value: string[] | null) => void
  disabled?: boolean
}): React.JSX.Element {
  const agents = participants.filter(
    (participant) => participant.actorKind === 'agent' && participant.participation === 'active'
  )
  return (
    <div className="mb-1 flex flex-wrap gap-1" aria-label="Message recipients">
      <Button
        type="button"
        variant={value === null ? 'secondary' : 'ghost'}
        size="xs"
        aria-pressed={value === null}
        disabled={disabled}
        onClick={() => onChange(null)}
      >
        {translate('rooms.queue.all', 'All')}
      </Button>
      {agents.map((participant) => {
        const selected = value?.includes(participant.id) === true
        return (
          <Button
            key={participant.id}
            type="button"
            variant={selected ? 'secondary' : 'ghost'}
            size="xs"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => {
              if (value === null) {
                onChange([participant.id])
                return
              }
              const next = value.includes(participant.id)
                ? value.filter((id) => id !== participant.id)
                : [...value, participant.id]
              onChange(next.length ? next : null)
            }}
          >
            {participant.displayName}
          </Button>
        )
      })}
    </div>
  )
}
