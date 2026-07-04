import { forwardRef, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Bot, BookOpen, FileSearch } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { ComposerAutocomplete, SlashCommandSuggestion } from './native-chat-composer-state'
import type { DiscoveredSkill } from '../../../../shared/skills'

export type NativeChatCommandMenuProps = {
  autocomplete: ComposerAutocomplete
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onChooseSlash: (command: SlashCommandSuggestion) => void
  onAcceptMention: () => void
  onChooseSkill: (skill: DiscoveredSkill) => void
}

export function NativeChatCommandMenu({
  autocomplete,
  activeIndex,
  onActiveIndexChange,
  onChooseSlash,
  onAcceptMention,
  onChooseSkill
}: NativeChatCommandMenuProps): React.JSX.Element | null {
  const activeItemRef = useRef<HTMLButtonElement | null>(null)
  const activeScrollKey = useMemo(() => {
    if (autocomplete.mode === 'slash') {
      return autocomplete.suggestions[activeIndex]?.name ?? null
    }
    if (autocomplete.mode === 'skill') {
      return autocomplete.suggestions[activeIndex]?.id ?? null
    }
    return autocomplete.mode
  }, [activeIndex, autocomplete])

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeScrollKey])

  if (autocomplete.mode === 'none') {
    return null
  }

  return (
    <div
      role="listbox"
      className="scrollbar-sleek absolute bottom-full left-0 right-0 z-20 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
    >
      {autocomplete.mode === 'slash' ? (
        autocomplete.suggestions.length > 0 ? (
          autocomplete.suggestions.map((command, index) => (
            <CommandMenuRow
              key={command.name}
              ref={index === activeIndex ? activeItemRef : null}
              active={index === activeIndex}
              icon={<Bot className="size-3.5" />}
              primary={`/${command.name}`}
              secondary={command.description}
              onMouseEnter={() => onActiveIndexChange(index)}
              onClick={() => onChooseSlash(command)}
            />
          ))
        ) : (
          <CommandMenuEmpty
            label={translate('components.native-chat.composer.noCommands', 'No matching commands')}
          />
        )
      ) : null}
      {autocomplete.mode === 'skill' ? (
        autocomplete.suggestions.length > 0 ? (
          autocomplete.suggestions.map((skill, index) => (
            <CommandMenuRow
              key={skill.id}
              ref={index === activeIndex ? activeItemRef : null}
              active={index === activeIndex}
              icon={<BookOpen className="size-3.5" />}
              primary={`$${skill.name}`}
              secondary={skill.description ?? undefined}
              trailing={skill.sourceLabel}
              onMouseEnter={() => onActiveIndexChange(index)}
              onClick={() => onChooseSkill(skill)}
            />
          ))
        ) : (
          <CommandMenuEmpty
            label={translate('components.native-chat.composer.noSkills', 'No matching skills')}
          />
        )
      ) : null}
      {autocomplete.mode === 'mention' ? (
        <CommandMenuRow
          active
          icon={<FileSearch className="size-3.5" />}
          primary={`@${autocomplete.query || '...'}`}
          secondary={translate(
            'components.native-chat.composer.mentionAction',
            'Reference a file or path'
          )}
          onClick={onAcceptMention}
        />
      ) : null}
    </div>
  )
}

type CommandMenuRowProps = {
  active?: boolean
  icon: ReactNode
  primary: string
  secondary?: string
  trailing?: string
  onMouseEnter?: () => void
  onClick: () => void
}

const CommandMenuRow = forwardRef<HTMLButtonElement, CommandMenuRowProps>(function CommandMenuRow(
  {
    active = false,
    icon,
    primary,
    secondary,
    trailing,
    onMouseEnter,
    onClick
  }: CommandMenuRowProps,
  ref
): React.JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={active}
      data-active={active ? 'true' : undefined}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-accent text-accent-foreground' : 'text-popover-foreground hover:bg-accent'
      )}
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{primary}</span>
        {secondary ? (
          <span className="block truncate text-xs text-muted-foreground">{secondary}</span>
        ) : null}
      </span>
      {trailing ? (
        <span className="ml-2 shrink-0 pt-0.5 text-[11px] text-muted-foreground">{trailing}</span>
      ) : null}
    </button>
  )
})

function CommandMenuEmpty({ label }: { label: string }): React.JSX.Element {
  return <div className="px-2 py-1.5 text-xs text-muted-foreground">{label}</div>
}
