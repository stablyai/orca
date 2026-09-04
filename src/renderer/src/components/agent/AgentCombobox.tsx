import React, { useCallback, useMemo, useState } from 'react'
import { ArrowRight, ChevronsUpDown, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import {
  agentPickerBlankTerminalMatches,
  getAgentPickerCommandValue,
  searchAgentPickerEntries
} from '@/lib/agent-picker-search'
import { cn } from '@/lib/utils'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  createAgentComboboxCommandState,
  resolveAgentComboboxCommandState,
  updateAgentComboboxCommandValue
} from './agent-combobox-command-state'
import { translate } from '@/i18n/i18n'
import {
  AgentComboboxDefaultContextMenu,
  AgentComboboxIconLabel,
  renderAgentComboboxItem
} from './AgentComboboxItem'

type DefaultAgentPreference = TuiAgent | 'blank' | null

export type CustomAgentComboboxEntry = {
  id: string
  label: string
  cmd: string
  baseAgent: TuiAgent
}

type AgentComboboxProps = {
  agents: AgentCatalogEntry[]
  value: TuiAgent | null
  onValueChange: (agent: TuiAgent | null) => void
  customAgents?: readonly CustomAgentComboboxEntry[]
  customValue?: string | null
  onCustomValueChange?: (profileId: string | null) => void
  onValueSelected?: (agent: TuiAgent | null) => void
  onOpenManageAgents?: () => void
  /** Current saved default agent preference. Used to render a subtle "default"
   *  indicator in the list and to tell which right-click menu item is the
   *  currently-applied choice. */
  defaultAgent?: DefaultAgentPreference
  /** Optional handler for right-click "Set as default" action. When provided,
   *  the selected trigger and each list item get a context menu. */
  onSetDefault?: (agent: DefaultAgentPreference) => void
  triggerClassName?: string
  /** When set, pressing Enter on the closed combobox trigger invokes this
   *  instead of opening the popover — lets the parent form treat the Agent
   *  field as the last keyboard-submit step. */
  onTriggerEnter?: () => void
  allowNarrowTrigger?: boolean
  allowBlankTerminal?: boolean
  emptyLabel?: string
}

const BLANK_VALUE = '__none__'
const CUSTOM_VALUE_PREFIX = '__custom__:'
const TRIGGER_MIN_WIDTH_CLASS = '!min-w-[260px]'
const NO_CUSTOM_AGENTS: readonly CustomAgentComboboxEntry[] = []

export default function AgentCombobox({
  agents,
  value,
  onValueChange,
  customAgents = NO_CUSTOM_AGENTS,
  customValue = null,
  onCustomValueChange,
  onValueSelected,
  onOpenManageAgents,
  defaultAgent,
  onSetDefault,
  triggerClassName,
  onTriggerEnter,
  allowNarrowTrigger = false,
  allowBlankTerminal = true,
  emptyLabel
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
    () => (!customValue && value ? (agents.find((agent) => agent.id === value) ?? null) : null),
    [agents, customValue, value]
  )
  const selectedCustomAgent = useMemo(
    () => customAgents.find((agent) => agent.id === customValue) ?? null,
    [customAgents, customValue]
  )
  const selectedDefaultPreference = customValue
    ? null
    : (value ?? (allowBlankTerminal ? 'blank' : null))
  const searchableAgents = useMemo(
    () => [
      ...agents.map((agent) => ({ ...agent, baseAgent: agent.id, profileId: null })),
      ...customAgents.map((agent) => ({
        ...agent,
        id: `${CUSTOM_VALUE_PREFIX}${agent.id}`,
        profileId: agent.id
      }))
    ],
    [agents, customAgents]
  )
  const filteredAgents = useMemo(
    () => searchAgentPickerEntries(searchableAgents, query),
    [query, searchableAgents]
  )
  const pickerValue = customValue ? `${CUSTOM_VALUE_PREFIX}${customValue}` : value
  const blankMatchesQuery = useMemo(
    () => allowBlankTerminal && agentPickerBlankTerminalMatches(query),
    [allowBlankTerminal, query]
  )
  const activeCommandValue = getAgentPickerCommandValue({
    blankValue: BLANK_VALUE,
    blankMatchesQuery,
    currentValue: pickerValue,
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
        setCommandState(createAgentComboboxCommandState(pickerValue ?? BLANK_VALUE))
        return
      }
      cancelFocusFrame()
      setQuery('')
    },
    [cancelFocusFrame, pickerValue]
  )

  const handleSelect = useCallback(
    (nextValue: TuiAgent | null) => {
      onCustomValueChange?.(null)
      onValueChange(nextValue)
      setOpen(false)
      setQuery('')
      onValueSelected?.(nextValue)
    },
    [onCustomValueChange, onValueChange, onValueSelected]
  )

  const handleSelectCustom = useCallback(
    (profileId: string) => {
      onCustomValueChange?.(profileId)
      setOpen(false)
      setQuery('')
    },
    [onCustomValueChange]
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
        setCommandState(createAgentComboboxCommandState(pickerValue ?? BLANK_VALUE))
        setOpen(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault()
        setCommandState(createAgentComboboxCommandState(pickerValue ?? BLANK_VALUE))
        setQuery(event.key)
        setOpen(true)
      }
    },
    [open, onTriggerEnter, pickerValue]
  )

  return (
    // Why: min-w-0 lets full-width form rows shrink; plain flex+items-center left the
    // trigger free to overflow its dialog column and look misaligned with Project/Name.
    <div className="min-w-0 w-full">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <AgentComboboxDefaultContextMenu
          isDefault={
            selectedDefaultPreference !== null && defaultAgent === selectedDefaultPreference
          }
          onSetDefault={
            onSetDefault && selectedDefaultPreference !== null
              ? () => onSetDefault(selectedDefaultPreference)
              : undefined
          }
        >
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
                // py-0 clears the default size's py-2 so icon+label center in h-8/h-9.
                'h-8 justify-between px-3 py-0 text-xs font-normal',
                triggerClassName,
                !allowNarrowTrigger && TRIGGER_MIN_WIDTH_CLASS
              )}
              data-agent-combobox-root="true"
            >
              {selectedCustomAgent ? (
                <AgentComboboxIconLabel
                  icon={<AgentIcon agent={selectedCustomAgent.baseAgent} size={14} />}
                  label={selectedCustomAgent.label}
                />
              ) : selectedAgent ? (
                <AgentComboboxIconLabel
                  icon={<AgentIcon agent={selectedAgent.id} size={14} />}
                  label={selectedAgent.label}
                />
              ) : (
                <AgentComboboxIconLabel
                  icon={<Terminal className="size-3.5" />}
                  label={
                    emptyLabel ??
                    translate('auto.components.agent.AgentCombobox.986f946354', 'Blank Terminal')
                  }
                />
              )}
              <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
        </AgentComboboxDefaultContextMenu>
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
              placeholder={translate(
                'auto.components.agent.AgentCombobox.48c6a5a9b4',
                'Search agents...'
              )}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {translate(
                  'auto.components.agent.AgentCombobox.579c768bde',
                  'No agents match your search.'
                )}
              </CommandEmpty>
              {blankMatchesQuery
                ? renderAgentComboboxItem({
                    key: BLANK_VALUE,
                    itemValue: BLANK_VALUE,
                    isChecked: value === null,
                    isDefault: defaultAgent === 'blank',
                    onSelect: () => handleSelect(null),
                    onSetDefault: onSetDefault ? () => onSetDefault('blank') : undefined,
                    icon: <Terminal className="size-3.5" />,
                    label: translate(
                      'auto.components.agent.AgentCombobox.986f946354',
                      'Blank Terminal'
                    )
                  })
                : null}
              {filteredAgents.map((agent) => {
                const profileId = agent.profileId
                return renderAgentComboboxItem({
                  key: agent.id,
                  itemValue: agent.id,
                  isChecked: profileId
                    ? customValue === profileId
                    : !customValue && value === agent.baseAgent,
                  isDefault: !profileId && defaultAgent === agent.baseAgent,
                  onSelect: profileId
                    ? () => handleSelectCustom(profileId)
                    : () => handleSelect(agent.baseAgent),
                  onSetDefault:
                    !profileId && onSetDefault ? () => onSetDefault(agent.baseAgent) : undefined,
                  icon: <AgentIcon agent={agent.baseAgent} />,
                  label: agent.label
                })
              })}
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
                  {translate('auto.components.agent.AgentCombobox.19522e25ee', 'Manage agents')}
                  <ArrowRight className="ml-auto size-3" />
                </Button>
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
