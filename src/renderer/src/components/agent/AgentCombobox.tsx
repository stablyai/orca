import React, { useCallback, useMemo, useState } from 'react'
import { ArrowRight, ChevronsUpDown, Terminal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import {
  AgentDefaultContextMenu,
  AgentIconLabel,
  renderAgentComboboxItem
} from './agent-combobox-items'
import { translate } from '@/i18n/i18n'
import { rowLabel } from '@/components/tab-bar/tab-agent-row-presentation'
import {
  SurfaceAgentItems,
  surfaceCommandValues,
  useSurfaceRowArming,
  type AgentComboboxSurfaceRows
} from './agent-combobox-surface-items'

type DefaultAgentPreference = TuiAgent | 'blank' | null

// Blank Terminal is opt-in; agent-only automation/source-control flows cannot run it or accept null.
type AgentComboboxSelectionProps =
  | { allowBlankTerminal: true; onValueChange: (agent: TuiAgent | null) => void }
  | { allowBlankTerminal?: false; onValueChange: (agent: TuiAgent) => void }

type AgentComboboxProps = AgentComboboxSelectionProps & {
  agents: AgentCatalogEntry[]
  value: TuiAgent | null
  onOpenManageAgents?: () => void
  /** Saved default used for list indicators and right-click default actions. */
  defaultAgent?: DefaultAgentPreference
  /** Enable default-setting context menus on the selected trigger and list items. */
  onSetDefault?: (agent: DefaultAgentPreference) => void
  triggerClassName?: string
  /** Let the parent submit on Enter from the closed trigger instead of opening the picker. */
  onTriggerEnter?: () => void
  allowNarrowTrigger?: boolean
  /** Clearing is separate from selecting Blank Terminal. */
  clearSelection?: {
    cleared: boolean
    onClear: () => void
  }
  /** Lists the "+" menu's chat and CLI rows instead of `agents`; picks go to `onPick`. */
  surfaceRows?: AgentComboboxSurfaceRows
}

const BLANK_VALUE = '__none__'
const TRIGGER_MIN_WIDTH_CLASS = '!min-w-[260px]'

export default function AgentCombobox({
  agents,
  value,
  onOpenManageAgents,
  defaultAgent,
  onSetDefault,
  triggerClassName,
  onTriggerEnter,
  allowNarrowTrigger = false,
  clearSelection,
  surfaceRows,
  ...selection
}: AgentComboboxProps): React.JSX.Element {
  const allowBlankTerminal = selection.allowBlankTerminal === true
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Control cmdk selection so hovering the external footer clears the last highlighted agent.
  const [commandState, setCommandState] = useState(() => createAgentComboboxCommandState(''))
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const focusFrameRef = React.useRef<number | null>(null)

  const selectedAgent = useMemo<AgentCatalogEntry | null>(
    () => (value ? (agents.find((agent) => agent.id === value) ?? null) : null),
    [agents, value]
  )
  const selectionCleared = clearSelection?.cleared === true
  const selectedDefaultPreference = selectionCleared
    ? null
    : (value ?? (allowBlankTerminal ? 'blank' : null))
  const canClear = clearSelection !== undefined && !selectionCleared
  const filteredAgents = useMemo(() => searchAgentPickerEntries(agents, query), [agents, query])
  const blankMatchesQuery = useMemo(
    () => allowBlankTerminal && agentPickerBlankTerminalMatches(query),
    [allowBlankTerminal, query]
  )
  const pickerValues = { agents, query, value, blankValue: BLANK_VALUE, blankMatchesQuery }
  const surface = surfaceRows ? surfaceCommandValues(surfaceRows.model, pickerValues) : null
  const surfaceList = surface?.rows ?? []
  const openCommandValue = selectionCleared
    ? ''
    : ((surface ? surface.selected : value) ?? BLANK_VALUE)
  const pickedCommandValue = surface
    ? surface.highlighted
    : getAgentPickerCommandValue({
        ...pickerValues,
        currentValue: value,
        filteredAgents,
        rawQuery: query
      })
  const activeCommandValue = selectionCleared && !query ? '' : pickedCommandValue
  const resolvedCommandState = resolveAgentComboboxCommandState(
    commandState,
    open,
    activeCommandValue
  )
  if (resolvedCommandState !== commandState) {
    // Reconcile query/results before paint without replacing manual hover until the candidate changes.
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
      // Append after the key that seeded search instead of selecting and replacing it.
      const end = searchInput.value.length
      searchInput.setSelectionRange(end, end)
    })
  }, [cancelFocusFrame])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen) {
        setCommandState(createAgentComboboxCommandState(openCommandValue))
        return
      }
      cancelFocusFrame()
      setQuery('')
    },
    [cancelFocusFrame, openCommandValue]
  )

  const closePicker = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  const handleSurfacePick: AgentComboboxSurfaceRows['onPick'] = (agent, surface) => {
    surfaceRows?.onPick(agent, surface)
    closePicker()
  }
  const arming = useSurfaceRowArming(surfaceList, commandValue, handleSurfacePick, {
    key: JSON.stringify([open, query, surfaceRows?.contextKey]),
    model: surfaceRows?.model
  })
  const picksCli = surfaceRows?.selection.cli === true

  const handleSelectAgent = (nextValue: TuiAgent): void => {
    selection.onValueChange(nextValue)
    closePicker()
  }

  const handleSelectBlank = (): void => {
    if (selection.allowBlankTerminal) {
      selection.onValueChange(null)
    }
    closePicker()
  }

  // Match RepoCombobox: plain focus confirms the selection; arrows open unfiltered, printable non-whitespace keys open and seed a new query.
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
        setCommandState(createAgentComboboxCommandState(openCommandValue))
        setOpen(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault()
        setCommandState(createAgentComboboxCommandState(openCommandValue))
        setQuery(event.key)
        setOpen(true)
      }
    },
    [open, onTriggerEnter, openCommandValue]
  )

  return (
    // Allow full-width form rows to shrink within their dialog column.
    <div className="relative min-w-0 w-full">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <AgentDefaultContextMenu
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
              // Why: the "(CLI)" suffix depends on the host's answer; it never pops in on a settled field.
              disabled={surfaceRows?.selection.ready === false && value !== null}
              className={cn(
                // Retain room for long labels; py-0 clears default vertical padding to center content in h-8/h-9.
                'h-8 justify-between px-3 py-0 text-xs font-normal',
                triggerClassName,
                !allowNarrowTrigger && TRIGGER_MIN_WIDTH_CLASS
              )}
              data-agent-combobox-root="true"
            >
              <span className={cn('inline-flex min-w-0 flex-1', canClear && 'pr-8')}>
                {selectionCleared ? (
                  <span className="truncate text-muted-foreground">
                    {translate(
                      'components.agentSessionContinuation.selectAgent',
                      'Select an Agent'
                    )}
                  </span>
                ) : selectedAgent ? (
                  <AgentIconLabel
                    icon={<AgentIcon agent={selectedAgent.id} size={14} />}
                    label={
                      picksCli
                        ? rowLabel({ kind: 'cli', agent: selectedAgent.id })
                        : selectedAgent.label
                    }
                  />
                ) : (
                  <AgentIconLabel
                    icon={<Terminal className="size-3.5" />}
                    label={
                      allowBlankTerminal
                        ? translate(
                            'auto.components.agent.AgentCombobox.986f946354',
                            'Blank Terminal'
                          )
                        : translate(
                            'components.agentSessionContinuation.selectAgent',
                            'Select an Agent'
                          )
                    }
                  />
                )}
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
        </AgentDefaultContextMenu>
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
          <Command
            shouldFilter={false}
            value={commandValue}
            onValueChange={setCommandValue}
            onKeyDown={surfaceRows ? arming.onKeyDown : undefined}
          >
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
                    isChecked: value === null && !selectionCleared,
                    isDefault: defaultAgent === 'blank',
                    onSelect: handleSelectBlank,
                    onSetDefault: onSetDefault ? () => onSetDefault('blank') : undefined,
                    icon: <Terminal className="size-3.5" />,
                    label: translate(
                      'auto.components.agent.AgentCombobox.986f946354',
                      'Blank Terminal'
                    )
                  })
                : null}
              {surfaceRows ? (
                <SurfaceAgentItems
                  surfaceRows={{ ...surfaceRows, onPick: handleSurfacePick }}
                  rows={surfaceList}
                  value={value}
                  armedValue={arming.armedValue}
                  defaultAgent={defaultAgent}
                  onSetDefault={onSetDefault}
                />
              ) : null}
              {(surfaceRows ? [] : filteredAgents).map((agent) =>
                renderAgentComboboxItem({
                  key: agent.id,
                  itemValue: agent.id,
                  isChecked: value === agent.id,
                  isDefault: defaultAgent === agent.id,
                  onSelect: () => handleSelectAgent(agent.id),
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
                  {translate('auto.components.agent.AgentCombobox.19522e25ee', 'Manage agents')}
                  <ArrowRight className="ml-auto size-3" />
                </Button>
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
      {canClear && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute right-8 top-1/2 -translate-y-1/2"
              aria-label={translate(
                'components.agentCombobox.clearSelection',
                'Clear agent selection'
              )}
              onClick={() => {
                clearSelection.onClear()
                closePicker()
                triggerRef.current?.focus()
              }}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('components.agentCombobox.clearSelection', 'Clear agent selection')}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
