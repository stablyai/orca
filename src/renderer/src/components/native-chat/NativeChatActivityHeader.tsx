import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { briefToolArg } from '../../../../shared/native-chat-tool-summary'
import { isSubagentToolName, nativeChatToolLabel } from '../../../../shared/native-chat-tool-name'
import { ActivityKindIcon } from '../rooms/RoomActivityTimeline'
import { buildRoomActivitySections } from '../rooms/room-activity-timeline'

export function NativeChatActivityHeader({
  messages,
  startedAt,
  completedAt,
  outcome,
  expanded,
  onExpandedChange
}: {
  messages: NativeChatMessage[]
  startedAt: number | null
  completedAt: number | null
  outcome: 'completed' | 'interrupted' | 'failed' | null
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const sections = useMemo(() => buildRoomActivitySections(messages), [messages])
  const latest = sections.at(-1)
  const latestTool = latest?.kind === 'tools' ? latest.tools.at(-1) : null
  const subagentTool = latestTool ? isSubagentToolName(latestTool.call.name) : false
  const label = latestTool
    ? subagentTool
      ? nativeChatToolLabel(latestTool.call.name)
      : liveActivityLabel(latestTool.kind)
    : 'Thinking'
  const detail = latestTool && !subagentTool ? briefToolArg(latestTool.call.input) : null

  useEffect(() => {
    if (outcome !== null) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [outcome])

  const hasDetails = messages.length > 0
  const completed = outcome === 'completed' && startedAt !== null && completedAt !== null
  const terminalLabel =
    outcome === 'interrupted'
      ? translate('rooms.activity.interrupted', 'Interrupted')
      : outcome === 'failed'
        ? translate('rooms.activity.failed', 'Failed')
        : translate('rooms.activity.completed', 'Completed')

  return (
    <button
      type="button"
      disabled={!hasDetails}
      aria-expanded={hasDetails ? expanded : undefined}
      onClick={() => onExpandedChange(!expanded)}
      className={cn(
        'flex max-w-full items-center gap-1.5 text-xs text-muted-foreground',
        hasDetails && 'hover:text-foreground'
      )}
    >
      {outcome ? null : latestTool ? (
        <ActivityKindIcon kind={latestTool.kind} />
      ) : (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      )}
      <span className="shrink-0">
        {completed
          ? translate('rooms.activity.workedFor', 'Worked for {{duration}}', {
              duration: formatElapsed(startedAt, completedAt)
            })
          : outcome
            ? terminalLabel
            : label}
      </span>
      {!outcome && detail ? <span className="truncate font-mono">· {detail}</span> : null}
      {!outcome && startedAt != null ? (
        <span className="shrink-0 text-muted-foreground/70">· {formatElapsed(startedAt, now)}</span>
      ) : null}
      {hasDetails ? (
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-200 ease motion-reduce:transition-none',
            expanded && 'rotate-90'
          )}
        />
      ) : null}
    </button>
  )
}

function liveActivityLabel(kind: Parameters<typeof ActivityKindIcon>[0]['kind']): string {
  const labels = {
    editing: 'Editing file',
    command: 'Running command',
    reading: 'Reading file',
    searching: 'Searching code',
    web: 'Searching the web'
  } as const
  return labels[kind] ?? 'Thinking'
}

function formatElapsed(startedAt: number, completedAt: number): string {
  const seconds = Math.max(1, Math.round((completedAt - startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}
