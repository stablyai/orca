import type { RefObject } from 'react'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { WorkspaceEmojiSuggestion } from '@/lib/workspace-emoji-shortcodes'

type WorkspaceEmojiSuggestionPopoverProps = {
  anchorRef: RefObject<HTMLInputElement | null>
  commandValue: string
  heading: string
  onCommandValueChange: (value: string) => void
  onOpenChange: (open: boolean) => void
  onSelect: (suggestion: WorkspaceEmojiSuggestion) => void
  open: boolean
  suggestions: readonly WorkspaceEmojiSuggestion[]
}

export function WorkspaceEmojiSuggestionPopover({
  anchorRef,
  commandValue,
  heading,
  onCommandValueChange,
  onOpenChange,
  onSelect,
  open,
  suggestions
}: WorkspaceEmojiSuggestionPopoverProps): React.JSX.Element {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLInputElement>} />
      <PopoverContent
        data-workspace-emoji-suggestions="true"
        align="start"
        side="top"
        sideOffset={4}
        avoidCollisions={false}
        className="popover-scroll-content flex max-h-56 w-[var(--radix-popover-trigger-width)] flex-col p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) {
            event.preventDefault()
          }
        }}
        onFocusOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) {
            event.preventDefault()
          }
        }}
      >
        <Command
          value={commandValue}
          onValueChange={onCommandValueChange}
          shouldFilter={false}
          className="bg-transparent"
        >
          <CommandList className="!max-h-none min-h-0 flex-1 scrollbar-sleek">
            <CommandGroup heading={heading} className="p-1">
              {suggestions.map((suggestion) => (
                <CommandItem
                  key={suggestion.shortcode}
                  value={`emoji:${suggestion.shortcode}`}
                  onSelect={() => onSelect(suggestion)}
                  className="gap-2 px-3 py-2 text-xs"
                >
                  <span className="w-5 shrink-0 text-center text-base leading-none">
                    {suggestion.emoji}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                    :{suggestion.shortcode}:
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
