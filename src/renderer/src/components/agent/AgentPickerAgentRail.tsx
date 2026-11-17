import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react'
import { Check, SquareTerminal } from 'lucide-react'
import { AgentVariantIcon } from '@/components/agent/icons/AgentVariantIcon'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { AgentDefaultContextMenu } from './agent-combobox-items'
import type { AgentPickerChoice } from './agent-picker-search-rows'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

type Agent = AgentPickerEntry['agent']

// The Blank Terminal pane has no search; its list takes focus instead.
const focusSearch = (from: Element) =>
  from
    .closest('[data-agent-launch-picker]')
    ?.querySelector<HTMLElement>('[cmdk-input], [data-agent-picker-blank-terminal]')
    ?.focus({ preventScroll: true })

const focusOnMount = (node: HTMLElement | null) => node?.focus({ preventScroll: true })

export function AgentPickerAgentTabs({
  entries,
  pane,
  blankTerminal,
  defaultAgent,
  onSetDefault,
  onSelect
}: {
  entries: AgentPickerEntry[]
  /** Null while the Blank Terminal tile is the selected tab. */
  pane: Agent | null
  blankTerminal?: AgentPickerChoice
  defaultAgent?: Agent | 'blank' | null
  onSetDefault?: (agent: Agent) => void
  onSelect: (agent: Agent) => void
}) {
  const t = useTranslate()
  const rail = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = rail.current
    if (!node) {
      return
    }
    // Why non-passive: a mouse wheel's vertical turn scrolls the overflowing rail sideways.
    const onWheel = (event: WheelEvent) => {
      if (
        node.scrollWidth <= node.clientWidth ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      ) {
        return
      }
      event.preventDefault()
      node.scrollLeft += event.deltaY
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])
  return (
    // Why: once one tab's label shows, the next tab's shows without a second wait.
    <TooltipProvider skipDelayDuration={300}>
      <div
        ref={rail}
        role="tablist"
        aria-label={t('agentPicker.agents', 'Agents')}
        className="flex shrink-0 items-center overflow-x-auto border-b border-border px-1.5 hover-scrollbar-x"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            return
          }
          // The menu would read these keys as typeahead and item moves.
          event.stopPropagation()
          const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
          const index = event.target instanceof HTMLElement ? tabs.indexOf(event.target) : -1
          const move = (next: number) => {
            event.preventDefault()
            tabs[(next + tabs.length) % tabs.length]?.focus()
          }
          if (event.key === 'ArrowRight') {
            move(index + 1)
          } else if (event.key === 'ArrowLeft') {
            move(index - 1)
          } else if (event.key === 'Home') {
            move(0)
          } else if (event.key === 'End') {
            move(tabs.length - 1)
          } else if ((event.key === 'Tab' && !event.shiftKey) || event.key === 'ArrowDown') {
            event.preventDefault()
            focusSearch(event.currentTarget)
          }
        }}
      >
        {blankTerminal ? (
          <>
            <AgentDefaultContextMenu
              isDefault={blankTerminal.isDefault ?? false}
              onSetDefault={blankTerminal.onSetDefault}
            >
              <AgentPickerRailTab
                label={blankTerminal.label}
                selected={pane === null}
                onClick={blankTerminal.onSelect}
              >
                <SquareTerminal className="size-4" />
              </AgentPickerRailTab>
            </AgentDefaultContextMenu>
            <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
          </>
        ) : null}
        {entries.map((entry) => {
          const missing = entry.surfaces.length === 0
          return (
            <AgentDefaultContextMenu
              key={entry.agent}
              isDefault={defaultAgent === entry.agent}
              onSetDefault={onSetDefault && !missing ? () => onSetDefault(entry.agent) : undefined}
            >
              <AgentPickerRailTab
                label={entry.label}
                selected={entry.agent === pane}
                missing={missing}
                onClick={() => onSelect(entry.agent)}
              >
                <AgentVariantIcon agent={entry.agent} size={16} />
              </AgentPickerRailTab>
            </AgentDefaultContextMenu>
          )
        })}
      </div>
    </TooltipProvider>
  )
}

function AgentPickerRailTab({
  label,
  selected,
  missing,
  onClick,
  children,
  ...trigger
}: ComponentProps<'button'> & {
  label: string
  selected: boolean
  missing?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          // The context menu trigger above hands its handlers through here.
          {...trigger}
          type="button"
          role="tab"
          tabIndex={selected ? 0 : -1}
          aria-selected={selected}
          aria-label={label}
          // Why: a click keeps focus, and typing, in the search field.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
          className={cn(
            'grid h-9 w-[34px] shrink-0 place-items-center border-b-2 outline-none transition-[color,opacity] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
            selected
              ? 'border-foreground text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
            missing && (selected ? 'opacity-60' : 'opacity-40 hover:opacity-70')
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** The form holds Blank Terminal: its one checked row, which closes as a current model row does. */
export function AgentPickerBlankTerminalPane({
  label,
  disabled,
  onClose
}: {
  label: string
  disabled?: boolean
  onClose: () => void
}) {
  return (
    <Command
      ref={focusOnMount}
      surface="inline"
      density="model"
      data-agent-picker-blank-terminal=""
      // Why: the model rows' selection surface.
      data-agent-launch-setup=""
      onKeyDown={(event) => event.stopPropagation()}
    >
      <CommandList className="scroll-py-0">
        <CommandGroup>
          <CommandItem
            value="blank"
            selection="palette"
            disabled={disabled}
            data-current
            onSelect={onClose}
          >
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <Check className="size-3.5 text-muted-foreground" />
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  )
}
