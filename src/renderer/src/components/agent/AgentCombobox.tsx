import React, { useCallback, useMemo, useState } from 'react'
import { ArrowRight, Check, ChevronsUpDown, Star, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import {
  agentPickerBlankTerminalMatches,
  getAgentPickerCommandValue,
  searchAgentPickerEntries
} from '@/lib/agent-picker-search'
import { cn } from '@/lib/utils'
import type { TuiAgent } from '../../../../shared/types'
import {
  createAgentComboboxCommandState,
  resolveAgentComboboxCommandState,
  updateAgentComboboxCommandValue
} from './agent-combobox-command-state'
import { translate } from '@/i18n/i18n'

type DefaultAgentPreference = TuiAgent | 'blank' | null

type AgentComboboxProps = {
  agents: AgentCatalogEntry[]
  value: TuiAgent | null
  onValueChange: (agent: TuiAgent | null) => void
  onValueSelected?: (agent: TuiAgent | null) => void
  onOpenManageAgents?: () => void
  /** Current saved default agent preference. Used to render a subtle "default"
   *  indicator in the list and to tell which right-click menu item is the
   *  currently-applied choice. */
  defaultAgent?: DefaultAgentPreference
  /** Optional handler for right-click "Set as default" action. When provided,
   *  each list item (including Blank Terminal) gets a context menu. */
  onSetDefault?: (agent: DefaultAgentPreference) => void
  triggerClassName?: string
  /** When set, pressing Enter on the closed combobox trigger invokes this
   *  instead of opening the popover — lets the parent form treat the Agent
   *  field as the last keyboard-submit step. */
  onTriggerEnter?: () => void
  allowNarrowTrigger?: boolean
}

const BLANK_VALUE = '__none__'
const TRIGGER_MIN_WIDTH_CLASS = '!min-w-[260px]'

type ItemRenderArgs = {
  key: string
  itemValue: string
  isChecked: boolean
  isDefault: boolean
  onSelect: () => void
  onSetDefault?: () => void
  icon: React.ReactNode
  label: string
}

function renderItem({
  key,
  itemValue,
  isChecked,
  isDefault,
  onSelect,
  onSetDefault,
  icon,
  label
}: ItemRenderArgs): React.ReactNode {
  const row = (
    <CommandItem
      key={key}
      value={itemValue}
      onSelect={onSelect}
      className="items-center gap-2 px-3 py-1.5"
    >
      <Check className={cn('size-4 text-foreground', isChecked ? 'opacity-100' : 'opacity-0')} />
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
        {icon}
        <span className="truncate">{label}</span>
      </span>
    </CommandItem>
  )
  if (!onSetDefault) {
    return row
  }
  return (
    // Why: z-[70] sits above PopoverContent's z-[60] so the right-click menu
    // renders in front of the still-open combobox popover instead of behind it.
    <ContextMenu key={key}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="z-[70]">
        <ContextMenuItem onSelect={onSetDefault} disabled={isDefault}>
          <Star className="size-3.5" />
          {isDefault ? translate("auto.components.agent.AgentCombobox.1b0d6965fa", "Current default") : translate("auto.components.agent.AgentCombobox.9c6b59fe58", "Set as default")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export default function AgentCombobox({
  agents,
  value,
  onValueChange,
  onValueSelected,
  onOpenManageAgents,
  defaultAgent,
  onSetDefault,
  triggerClassName,
  onTriggerEnter,
  allowNarrowTrigger = false
}: AgentComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Why: controlled cmdk selection so hovering the footer (which lives outside
  // the cmdk tree) can clear the list's highlighted item — otherwise cmdk keeps
  // the last-hovered agent visually selected while the mouse is on the footer.
  const [commandState, setCommandState] = useState(() => createAgentComboboxCommandState(''))
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const focusFrameRef = React.useRef<number | null>(null)

  const selectedAgent = useMemo<AgentCatalogEntry | null>(
    () => (value ? (agents.find((agent) => agent.id === value) ?? null) : null),
    [agents, value]
  )
  const filteredAgents = useMemo(() => searchAgentPickerEntries(agents, query), [agents, query])
  const blankMatchesQuery = useMemo(() => agentPickerBlankTerminalMatches(query), [query])
  const activeCommandValue = getAgentPickerCommandValue({
    blankValue: BLANK_VALUE,
    blankMatchesQuery,
    currentValue: value,
    filteredAgents,
    rawQuery: query
  })
  const resolvedCommandState = resolveAgentComboboxCommandState(
    commandState,
    open,
    activeCommandValue
  )
  if (resolvedCommandState !== commandState) {
    // Why: cmdk highlights should follow query/result changes before paint,
    // while manual hover selection remains intact until the active candidate changes.
    setCommandState(resolvedCommandState)
  }
  const commandValue = resolvedCommandState.commandValue

  const cancelFocusFrame = useCallback((): void => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [])

  const setInputNode = useCallback(
    (node: HTMLInputElement | null): void => {
      if (node === null) {
        cancelFocusFrame()
      }
      inputRef.current = node
    },
    [cancelFocusFrame]
  )

  const setCommandValue = useCallback((nextCommandValue: string): void => {
    setCommandState((current) => updateAgentComboboxCommandValue(current, nextCommandValue))
  }, [])

  const focusSearchInput = useCallback(() => {
    cancelFocusFrame()
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      const searchInput = inputRef.current
      if (!searchInput) {
        return
      }
      searchInput.focus()
      // Why: when a printable keydown on the trigger seeded the query, the user
      // expects the next keystroke to append to what they typed — not replace
      // it — so drop the caret at the end instead of selecting all.
      const end = searchInput.value.length
      searchInput.setSelectionRange(end, end)
    })
  }, [cancelFocusFrame])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen) {
        setCommandState(createAgentComboboxCommandState(value ?? BLANK_VALUE))
        return
      }
      cancelFocusFrame()
      setQuery('')
    },
    [cancelFocusFrame, value]
  )

  const handleSelect = useCallback(
    (nextValue: TuiAgent | null) => {
      onValueChange(nextValue)
      setOpen(false)
      setQuery('')
      onValueSelected?.(nextValue)
    },
    [onValueChange, onValueSelected]
  )

  // Why: mirror RepoCombobox's trigger-keydown handling — the button-style
  // trigger treats the current value as a confirmed selection. Plain focus does
  // not open the dropdown. Only explicit intent opens: Arrow keys open without
  // filtering; a printable non-whitespace char opens AND seeds the search
  // query (treating the keystroke as the start of a new search).
  const handleTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (open) {
        return
      }
      if (
        event.key === 'Enter' &&
        onTriggerEnter &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault()
        onTriggerEnter()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setCommandState(createAgentComboboxCommandState(value ?? BLANK_VALUE))
        setOpen(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault()
        setCommandState(createAgentComboboxCommandState(value ?? BLANK_VALUE))
        setQuery(event.key)
        setOpen(true)
      }
    },
    [open, onTriggerEnter, value]
  )

  return (
    <div className="flex w-full items-center">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            onKeyDown={handleTriggerKeyDown}
            className={cn(
              // Why: callers sometimes pass `min-w-0` for grid layouts, but
              // the compact trigger still needs room for "GitHub Copilot".
              'h-8 justify-between px-3 text-xs font-normal',
              triggerClassName,
              !allowNarrowTrigger && TRIGGER_MIN_WIDTH_CLASS
            )}
            data-agent-combobox-root="true"
          >
            {selectedAgent ? (
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                <AgentIcon agent={selectedAgent.id} />
                <span className="truncate">{selectedAgent.label}</span>
              </span>
            ) : (
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                <Terminal className="size-3.5" />
                <span className="truncate">{translate("auto.components.agent.AgentCombobox.986f946354", "Blank Terminal")}</span>
              </span>
            )}
            <ChevronsUpDown className="size-3.5 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className={cn(
            'w-[var(--radix-popover-trigger-width)] p-0',
            !allowNarrowTrigger && 'min-w-[18rem]'
          )}
          data-agent-combobox-root="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            focusSearchInput()
          }}
        >
          <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
            <CommandInput
              ref={setInputNode}
              placeholder={translate("auto.components.agent.AgentCombobox.48c6a5a9b4", "Search agents...")}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>{translate("auto.components.agent.AgentCombobox.579c768bde", "No agents match your search.")}</CommandEmpty>
              {blankMatchesQuery
                ? renderItem({
                    key: BLANK_VALUE,
                    itemValue: BLANK_VALUE,
                    isChecked: value === null,
                    isDefault: defaultAgent === 'blank',
                    onSelect: () => handleSelect(null),
                    onSetDefault: onSetDefault ? () => onSetDefault('blank') : undefined,
                    icon: <Terminal className="size-3.5" />,
                    label: translate("auto.components.agent.AgentCombobox.986f946354", "Blank Terminal")
                  })
                : null}
              {filteredAgents.map((agent) =>
                renderItem({
                  key: agent.id,
                  itemValue: agent.id,
                  isChecked: value === agent.id,
                  isDefault: defaultAgent === agent.id,
                  onSelect: () => handleSelect(agent.id),
                  onSetDefault: onSetDefault ? () => onSetDefault(agent.id) : undefined,
                  icon: <AgentIcon agent={agent.id} />,
                  label: agent.label
                })
              )}
            </CommandList>
            {onOpenManageAgents ? (
              <div className="border-t border-border">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onOpenManageAgents}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setCommandValue('')}
                  className="h-9 w-full justify-start rounded-none px-3 text-xs font-normal text-muted-foreground"
                >
                  {translate("auto.components.agent.AgentCombobox.19522e25ee", "Manage agents")}<ArrowRight className="ml-auto size-3" />
                </Button>
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
