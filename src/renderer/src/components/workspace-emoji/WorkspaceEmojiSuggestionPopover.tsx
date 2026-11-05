import { useEffect, useRef, type ComponentProps, type RefObject } from 'react'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { WorkspaceEmojiSuggestion } from '@/lib/workspace-emoji-shortcodes'

type WorkspaceEmojiSuggestionPopoverProps = {
  anchorRef: RefObject<HTMLInputElement | null>
  commandValue: string
  contentClassName?: string
  heading: string
  onCommandValueChange: (value: string) => void
  onOpenChange: (open: boolean) => void
  onSelect: (suggestion: WorkspaceEmojiSuggestion) => void
  open: boolean
  portalContainer?: HTMLElement | null
  side?: ComponentProps<typeof PopoverContent>['side']
  suggestions: readonly WorkspaceEmojiSuggestion[]
}

export function WorkspaceEmojiSuggestionPopover({
  anchorRef,
  commandValue,
  contentClassName,
  heading,
  onCommandValueChange,
  onOpenChange,
  onSelect,
  open,
  portalContainer,
  side = 'top',
  suggestions
}: WorkspaceEmojiSuggestionPopoverProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  // cmdk only auto-scrolls when it owns the arrow keys; here selection is driven from the input.
  useEffect(() => {
    if (!open || !commandValue) {
      return
    }
    const item = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[cmdk-item=""]') ?? []
    ).find((node) => node.getAttribute('data-value') === commandValue)
    if (!item) {
      return
    }
    if (item.parentElement?.firstElementChild === item) {
      item
        .closest('[cmdk-group=""]')
        ?.querySelector('[cmdk-group-heading=""]')
        ?.scrollIntoView({ block: 'nearest' })
    }
    item.scrollIntoView({ block: 'nearest' })
  }, [commandValue, open, suggestions])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLInputElement>} />
      <PopoverContent
        data-workspace-emoji-suggestions="true"
        align="start"
        side={side}
        sideOffset={4}
        avoidCollisions={false}
        portalContainer={portalContainer}
        className={cn(
          'popover-scroll-content flex max-h-56 w-[var(--radix-popover-trigger-width)] flex-col p-0',
          contentClassName
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerDown={(event) => event.preventDefault()}
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
          <CommandList ref={listRef} className="!max-h-none min-h-0 flex-1 scrollbar-sleek">
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
