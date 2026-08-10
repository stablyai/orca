import { useState } from 'react'
import {
  ChevronRight,
  CircleStop,
  CircleX,
  FileText,
  Globe2,
  Pencil,
  Search,
  SquareTerminal
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { RoomActivityKind, RoomAgentActivity, RoomParticipant } from '../../../../shared/rooms'
import { hasRoomActivityDetails, RoomActivityDetails } from './RoomActivityTimeline'
import { RoomAuthorAvatar } from './RoomAuthorAvatar'
import { AgentSubagentTurnLink } from '../agent-subagents/AgentSubagentContext'

export function RoomActivityCard({
  activity,
  participant
}: {
  activity: RoomAgentActivity
  participant?: RoomParticipant
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const expandable = hasRoomActivityDetails(activity.messages, activity.detail)
  const label = activityLabel(activity)
  return (
    <div className="rounded-lg border border-border/70 bg-muted/15 px-3 py-2">
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 text-left text-xs',
          expandable ? 'cursor-pointer' : 'cursor-default'
        )}
        aria-expanded={expandable ? expanded : undefined}
        onClick={() => expandable && setExpanded((current) => !current)}
      >
        <RoomAuthorAvatar actorKind="agent" participant={participant} />
        <span className="shrink-0 font-semibold">@{activity.identity}</span>
        <ActivityIcon activity={activity} />
        <span
          className={cn(
            'truncate text-muted-foreground',
            activity.state === 'failed' && 'text-destructive'
          )}
        >
          · {label}
          {activity.detail ? ` · ${activity.detail}` : ''}
        </span>
        {expandable ? (
          <ChevronRight
            className={cn(
              'ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90'
            )}
          />
        ) : null}
      </button>
      {expanded ? (
        <RoomActivityDetails
          messages={activity.messages}
          fallback={{ kind: activity.kind, detail: activity.detail }}
        />
      ) : null}
      {participant ? (
        <AgentSubagentTurnLink
          sourceKey={participant.id}
          startedAt={activity.startedAt}
          completedAt={null}
          messages={activity.messages}
        />
      ) : null}
    </div>
  )
}

function ActivityIcon({ activity }: { activity: RoomAgentActivity }): React.JSX.Element {
  if (activity.state === 'failed') {
    return <CircleX className="size-3.5 shrink-0 text-destructive" />
  }
  if (activity.state === 'interrupted') {
    return <CircleStop className="size-3.5 shrink-0 text-muted-foreground" />
  }
  const Icon = ACTIVITY_ICONS[activity.kind]
  return Icon ? (
    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <span className="flex size-3.5 shrink-0 items-center justify-center gap-0.5">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-0.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: `${index * 140}ms` }}
        />
      ))}
    </span>
  )
}

function activityLabel(activity: RoomAgentActivity): string {
  if (activity.state === 'failed') {
    return translate('rooms.activity.failed', 'Failed')
  }
  if (activity.state === 'interrupted') {
    return translate('rooms.activity.interrupted', 'Interrupted')
  }
  return ACTIVITY_LABELS[activity.kind]()
}

const ACTIVITY_ICONS: Partial<
  Record<RoomActivityKind, React.ComponentType<{ className?: string }>>
> = {
  reading: FileText,
  searching: Search,
  editing: Pencil,
  command: SquareTerminal,
  web: Globe2
}

const ACTIVITY_LABELS: Record<RoomActivityKind, () => string> = {
  thinking: () => translate('rooms.activity.thinking', 'Thinking'),
  reading: () => translate('rooms.activity.reading', 'Reading file'),
  searching: () => translate('rooms.activity.searching', 'Searching code'),
  editing: () => translate('rooms.activity.editing', 'Editing file'),
  command: () => translate('rooms.activity.command', 'Running command'),
  web: () => translate('rooms.activity.web', 'Searching the web'),
  working: () => translate('rooms.activity.working', 'Working')
}
