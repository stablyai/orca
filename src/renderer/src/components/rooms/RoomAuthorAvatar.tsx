import { Bot, UserRound } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import type { RoomActorKind, RoomParticipant } from '../../../../shared/rooms'

export function RoomAuthorAvatar({
  actorKind,
  participant
}: {
  actorKind: RoomActorKind
  participant?: RoomParticipant
}): React.JSX.Element {
  return (
    <span
      data-room-author-avatar={actorKind}
      className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40"
      aria-hidden
    >
      {actorKind === 'agent' && participant?.agent ? (
        <AgentIcon agent={participant.agent} size={15} />
      ) : actorKind === 'user' ? (
        <UserRound className="size-3.5" />
      ) : (
        <Bot className="size-3.5" />
      )}
    </span>
  )
}
