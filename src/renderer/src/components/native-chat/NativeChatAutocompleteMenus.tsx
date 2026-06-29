import { useEffect, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { SlashCommandSuggestion } from './native-chat-composer-state'
import type { DiscoveredSkill } from '../../../../shared/skills'

export function NativeChatSlashMenu({
  suggestions,
  activeIndex,
  onChoose
}: {
  suggestions: SlashCommandSuggestion[]
  activeIndex: number
  onChoose: (command: SlashCommandSuggestion) => void
}): React.JSX.Element {
  return (
    <div className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-md border border-border bg-popover shadow-md sm:left-4 sm:right-4">
      {suggestions.map((command, index) => (
        <button
          key={command.name}
          type="button"
          onClick={() => onChoose(command)}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
            index === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground'
          )}
        >
          <span className="font-medium">/{command.name}</span>
          {command.description ? (
            <span className="truncate text-xs text-muted-foreground">{command.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

export function NativeChatMentionHint({
  query,
  onAccept
}: {
  query: string
  onAccept: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onAccept}
      className="absolute bottom-full left-3 right-3 mb-1 flex w-auto items-center gap-2 rounded-md border border-border bg-popover px-3 py-1.5 text-left text-xs text-muted-foreground shadow-md sm:left-4 sm:right-4"
    >
      {translate('components.native-chat.composer.mentionHint', 'Referencing file:')}{' '}
      <span className="font-medium text-foreground">@{query || '…'}</span>
    </button>
  )
}

export function NativeChatSkillMenu({
  suggestions,
  activeIndex,
  onChoose
}: {
  suggestions: DiscoveredSkill[]
  activeIndex: number
  onChoose: (skill: DiscoveredSkill) => void
}): React.JSX.Element {
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, suggestions])

  return (
    <div className="scrollbar-sleek absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
      {suggestions.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {translate('components.native-chat.composer.noSkills', 'No matching skills')}
        </div>
      ) : null}
      {suggestions.map((skill, index) => (
        <button
          key={skill.id}
          ref={index === activeIndex ? activeItemRef : null}
          type="button"
          onClick={() => onChoose(skill)}
          className={cn(
            'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
            index === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground'
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">${skill.name}</span>
            {skill.description ? (
              <span className="block truncate text-xs text-muted-foreground">
                {skill.description}
              </span>
            ) : null}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{skill.sourceLabel}</span>
        </button>
      ))}
    </div>
  )
}
