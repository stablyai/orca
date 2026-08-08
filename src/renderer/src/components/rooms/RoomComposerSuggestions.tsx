import type { RoomParticipant } from '../../../../shared/rooms'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export type RoomComposerQuery = {
  kind: 'mention' | 'command'
  start: number
  end: number
  query: string
}

export type RoomComposerSuggestion = { value: string; label: string }

export function getRoomComposerQuery(text: string, cursor: number): RoomComposerQuery | null {
  const before = text.slice(0, cursor)
  const command = before.match(/^\/([\p{L}\p{N}_-]*)$/u)
  if (command) {
    return { kind: 'command', start: 0, end: cursor, query: command[1] ?? '' }
  }
  const mention = before.match(/(^|\s)@([\p{L}\p{N}_-]*)$/u)
  if (!mention) {
    return null
  }
  const start = before.length - (mention[2]?.length ?? 0) - 1
  return { kind: 'mention', start, end: cursor, query: mention[2] ?? '' }
}

export function getRoomComposerSuggestions(
  query: RoomComposerQuery | null,
  participants: RoomParticipant[]
): RoomComposerSuggestion[] {
  if (!query) {
    return []
  }
  const needle = query.query.toLocaleLowerCase()
  const values =
    query.kind === 'command'
      ? [
          {
            value: '/continue',
            label: translate(
              'rooms.composer.continueSuggestion',
              '/continue · resume a paused agent loop'
            )
          }
        ]
      : [
          {
            value: '@all',
            label: translate('rooms.composer.allAgentsSuggestion', '@all · all agents')
          },
          ...participants
            .filter(
              (participant) =>
                participant.actorKind === 'agent' && participant.participation !== 'paused'
            )
            .map((participant) => ({
              value: `@${participant.identity}`,
              label: `@${participant.identity} · ${participant.state}`
            }))
        ]
  return values.filter((item) => item.value.slice(1).toLocaleLowerCase().includes(needle))
}

export function applyRoomComposerSuggestion(
  text: string,
  query: RoomComposerQuery,
  value: string
): { text: string; cursor: number } {
  const suffix = value.endsWith(' ') || /\s/u.test(text[query.end] ?? '') ? '' : ' '
  const inserted = `${value}${suffix}`
  return {
    text: `${text.slice(0, query.start)}${inserted}${text.slice(query.end)}`,
    cursor: query.start + inserted.length
  }
}

export function getExactRoomMentionSuggestion(
  query: RoomComposerQuery | null,
  suggestions: RoomComposerSuggestion[]
): RoomComposerSuggestion | null {
  if (query?.kind !== 'mention') {
    return null
  }
  const value = `@${query.query}`.toLocaleLowerCase()
  return suggestions.find((suggestion) => suggestion.value.toLocaleLowerCase() === value) ?? null
}

export function resolveSelectedRoomRecipients(
  selected: string[],
  participants: RoomParticipant[]
): string[] {
  const agents = participants.filter(
    (participant) => participant.actorKind === 'agent' && participant.participation !== 'paused'
  )
  if (selected.includes('@all')) {
    return agents.map((participant) => participant.identity)
  }
  const selectedLower = new Set(selected.map((recipient) => recipient.slice(1).toLocaleLowerCase()))
  return agents
    .filter((participant) => selectedLower.has(participant.identity.toLocaleLowerCase()))
    .map((participant) => participant.identity)
}

export function RoomComposerSuggestions({
  suggestions,
  activeIndex,
  onSelect
}: {
  suggestions: RoomComposerSuggestion[]
  activeIndex: number
  onSelect: (suggestion: RoomComposerSuggestion) => void
}): React.JSX.Element | null {
  if (suggestions.length === 0) {
    return null
  }
  return (
    <div className="mb-1 max-h-36 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-xs scrollbar-sleek">
      {suggestions.map((suggestion, index) => (
        <button
          key={suggestion.value}
          type="button"
          className={cn(
            'block w-full rounded px-2 py-1 text-left text-xs text-popover-foreground',
            index === activeIndex && 'bg-accent text-accent-foreground'
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(suggestion)}
        >
          {suggestion.label}
        </button>
      ))}
    </div>
  )
}
