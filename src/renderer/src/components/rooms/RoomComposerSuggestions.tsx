import { useCallback, useEffect, useRef, useState } from 'react'
import { UsersRound } from 'lucide-react'
import type { RoomParticipant } from '../../../../shared/rooms'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { RoomAuthorAvatar } from './RoomAuthorAvatar'

export type RoomComposerQuery = {
  kind: 'mention' | 'command'
  start: number
  end: number
  query: string
}

export type RoomComposerSuggestion = {
  value: string
  label: string
  participant?: RoomParticipant
  identity?: string
  displayName?: string
}

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
  const values: RoomComposerSuggestion[] =
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
            label: translate('rooms.composer.allAgentsSuggestion', '@all · all agents'),
            identity: 'all',
            displayName: translate('rooms.composer.allAgents', 'All agents')
          },
          ...participants
            .filter(
              (participant) =>
                participant.actorKind === 'agent' && participant.participation !== 'paused'
            )
            .filter((participant) => participant.identity.toLocaleLowerCase().includes(needle))
            .map((participant) => ({
              value: `@${participant.identity}`,
              label: `@${participant.identity}`,
              participant,
              identity: participant.identity,
              displayName: participant.displayName
            }))
        ]
  return values.filter((item) =>
    query.kind === 'command'
      ? item.value.slice(1).toLocaleLowerCase().includes(needle)
      : Boolean(item.participant) || item.value.slice(1).toLocaleLowerCase().includes(needle)
  )
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

export function resolveRoomComposerMentions(
  text: string,
  participants: RoomParticipant[]
): string[] {
  const selected = [...text.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu)].map((match) => `@${match[1]}`)
  const agents = participants.filter(
    (participant) => participant.actorKind === 'agent' && participant.participation !== 'paused'
  )
  if (selected.includes('@all')) {
    return agents.map((participant) => participant.identity)
  }
  const identities = new Map(
    agents.map((participant) => [participant.identity.toLocaleLowerCase(), participant.identity])
  )
  return [
    ...new Set(
      selected
        .map((recipient) => identities.get(recipient.slice(1).toLocaleLowerCase()))
        .filter((identity): identity is string => Boolean(identity))
    )
  ]
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
  const { rendered, open, finishClose } = useAnimatedSuggestions(suggestions)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  const previousActiveIndexRef = useRef(activeIndex)
  const [scrollEdges, setScrollEdges] = useState({ start: false, end: false })
  const activeValue = suggestions[activeIndex]?.value
  const renderedSignature = rendered
    .map(({ suggestion, visible }) => `${suggestion.value}:${visible ? 1 : 0}`)
    .join('|')
  const updateScrollEdges = useCallback(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    setScrollEdges({
      start: element.scrollTop > 1,
      end: element.scrollTop + element.clientHeight < element.scrollHeight - 1
    })
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(updateScrollEdges)
    const element = scrollRef.current
    const observer = element ? new ResizeObserver(updateScrollEdges) : null
    if (element) {
      observer?.observe(element)
      for (const child of element.children) {
        observer?.observe(child)
      }
    }
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [renderedSignature, updateScrollEdges])

  useEffect(() => {
    if (open && previousActiveIndexRef.current !== activeIndex) {
      activeRef.current?.scrollIntoView({ block: 'nearest' })
    }
    previousActiveIndexRef.current = activeIndex
  }, [activeIndex, open])

  if (rendered.length === 0) {
    return null
  }
  return (
    <div
      data-room-composer-suggestions={open ? 'open' : 'closed'}
      className="absolute inset-x-0 bottom-full z-0"
    >
      <div
        data-room-composer-suggestions-surface
        className={cn(
          'pb-2 transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-16 opacity-0'
        )}
        style={{
          transitionTimingFunction: 'cubic-bezier(0.12, 0.9, 0.2, 1), cubic-bezier(0.16, 1, 0.3, 1)'
        }}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && !open) {
            finishClose()
          }
        }}
      >
        <div className="relative overflow-hidden rounded-md border border-border bg-popover shadow-xs">
          <div
            ref={scrollRef}
            className="max-h-[13.5rem] overflow-y-auto p-1 scrollbar-sleek"
            onScroll={updateScrollEdges}
          >
            {rendered.map(({ suggestion, visible }) => {
              const active = suggestion.value === activeValue
              return (
                <div
                  key={suggestion.value}
                  aria-hidden={!visible || undefined}
                  inert={!visible || undefined}
                  className={cn(
                    'grid transition-[grid-template-rows,opacity,transform] duration-200 ease motion-reduce:transition-none',
                    visible
                      ? 'translate-y-0 grid-rows-[1fr] opacity-100'
                      : 'translate-y-1 grid-rows-[0fr] opacity-0'
                  )}
                >
                  <div className="min-h-0 overflow-hidden">
                    <button
                      ref={active ? activeRef : undefined}
                      type="button"
                      className={cn(
                        'flex h-12 w-full items-center gap-2 rounded px-2 text-left text-popover-foreground',
                        active && 'bg-accent text-accent-foreground'
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onSelect(suggestion)}
                    >
                      <SuggestionAvatar suggestion={suggestion} />
                      {suggestion.identity ? (
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {suggestion.displayName}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            @{suggestion.identity}
                          </span>
                        </span>
                      ) : (
                        <span className="truncate text-xs">{suggestion.label}</span>
                      )}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-popover to-transparent transition-opacity duration-200 ease',
              scrollEdges.start ? 'opacity-100' : 'opacity-0'
            )}
          />
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-popover to-transparent transition-opacity duration-200 ease',
              scrollEdges.end ? 'opacity-100' : 'opacity-0'
            )}
          />
        </div>
      </div>
    </div>
  )
}

function SuggestionAvatar({
  suggestion
}: {
  suggestion: RoomComposerSuggestion
}): React.JSX.Element | null {
  if (suggestion.participant) {
    return <RoomAuthorAvatar actorKind="agent" participant={suggestion.participant} />
  }
  if (suggestion.identity === 'all') {
    return (
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40"
        aria-hidden
      >
        <UsersRound className="size-3.5" />
      </span>
    )
  }
  return null
}

type AnimatedSuggestion = { suggestion: RoomComposerSuggestion; visible: boolean }

function useAnimatedSuggestions(suggestions: RoomComposerSuggestion[]): {
  rendered: AnimatedSuggestion[]
  open: boolean
  finishClose: () => void
} {
  const [rendered, setRendered] = useState<AnimatedSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const desiredValuesRef = useRef(new Set<string>())
  const suggestionsRef = useRef(suggestions)
  suggestionsRef.current = suggestions
  const signature = suggestions
    .map((suggestion) =>
      [suggestion.value, suggestion.displayName, suggestion.participant?.updatedAt].join(':')
    )
    .join('|')
  useEffect(() => {
    const nextSuggestions = suggestionsRef.current
    const desired = new Map(nextSuggestions.map((suggestion) => [suggestion.value, suggestion]))
    const wasOpen = desiredValuesRef.current.size > 0
    desiredValuesRef.current = new Set(desired.keys())
    setRendered((current) => {
      const next = current.map((item) => ({
        suggestion: desired.get(item.suggestion.value) ?? item.suggestion,
        visible: desired.size === 0 ? item.visible : desired.has(item.suggestion.value)
      }))
      const renderedValues = new Set(next.map((item) => item.suggestion.value))
      for (const [suggestionIndex, suggestion] of nextSuggestions.entries()) {
        if (renderedValues.has(suggestion.value)) {
          continue
        }
        const following = nextSuggestions
          .slice(suggestionIndex + 1)
          .find((item) => renderedValues.has(item.value))
        const index = following
          ? next.findIndex((item) => item.suggestion.value === following.value)
          : next.length
        next.splice(index, 0, { suggestion, visible: !wasOpen })
        renderedValues.add(suggestion.value)
      }
      return next
    })
    if (desired.size === 0) {
      setOpen(false)
    }
    let enterFrame: number | null = null
    const mountFrame = requestAnimationFrame(() => {
      enterFrame = requestAnimationFrame(() => {
        if (desiredValuesRef.current.size === 0) {
          return
        }
        setOpen(true)
        setRendered((current) =>
          current.map((item) => ({
            ...item,
            visible: desiredValuesRef.current.has(item.suggestion.value)
          }))
        )
      })
    })
    const timeout =
      desired.size > 0
        ? window.setTimeout(() => {
            setRendered((current) =>
              current.filter((item) => desiredValuesRef.current.has(item.suggestion.value))
            )
          }, 200)
        : null
    return () => {
      cancelAnimationFrame(mountFrame)
      if (enterFrame !== null) {
        cancelAnimationFrame(enterFrame)
      }
      if (timeout !== null) {
        clearTimeout(timeout)
      }
    }
  }, [signature])
  const finishClose = useCallback(() => {
    if (desiredValuesRef.current.size === 0) {
      setRendered([])
    }
  }, [])
  return { rendered, open, finishClose }
}
