import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'

export function TerminalRichInputSlashMenu({
  id,
  suggestions,
  activeIndex,
  onChoose
}: {
  id: string
  suggestions: readonly SlashCommandSuggestion[]
  activeIndex: number
  onChoose: (command: SlashCommandSuggestion) => void
}): React.JSX.Element | null {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  if (suggestions.length === 0) {
    return null
  }
  return (
    <div
      id={id}
      className="scrollbar-sleek absolute bottom-full left-0 right-0 z-20 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      data-terminal-rich-input-menu=""
      role="listbox"
      aria-label={translate('components.terminal.richInput.slashCommands', 'Slash commands')}
    >
      {suggestions.map((command, index) => (
        <Button
          id={`${id}-option-${index}`}
          key={command.name}
          ref={index === activeIndex ? activeRef : undefined}
          type="button"
          variant="ghost"
          size="sm"
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(command)}
          className={cn(
            'h-auto min-w-0 w-full justify-start rounded-sm px-2 py-1.5 text-left text-sm',
            index === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground'
          )}
        >
          <span className="shrink-0 font-medium">/{command.name}</span>
          {command.description ? (
            <span className="truncate text-xs text-muted-foreground">{command.description}</span>
          ) : null}
        </Button>
      ))}
    </div>
  )
}
