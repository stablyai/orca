import React, { useCallback, useId, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowRight, Check, ChevronsUpDown, Star, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  searchAgentPickerEntries
} from '@/lib/agent-picker-search'
import { cn } from '@/lib/utils'
import type { BuiltInTuiAgent, TuiAgent } from '../../../../shared/types'
import { AgentPickerListbox, type AgentPickerListboxItem } from './AgentPickerListbox'
import { translate } from '@/i18n/i18n'

type DefaultAgentPreference = TuiAgent | 'blank' | null

/** The current value when it points at a deleted/disabled agent: kept selected
 *  with a repair warning, never silently rebound to Blank Terminal. */
export type AgentComboboxStale = { label: string; baseAgent: BuiltInTuiAgent }

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
   *  the selected trigger and each list item get a context menu. */
  onSetDefault?: (agent: DefaultAgentPreference) => void
  /** Optional richer label/icon for a stale value (deleted/disabled agent). The
   *  stale state itself is detected from `value` being set but absent from
   *  `agents`; this only supplies the human label and base icon. */
  staleAgent?: AgentComboboxStale | null
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
const TRIGGER_MIN_WIDTH_CLASS = '!min-w-[260px]'

type AgentPickerRow = AgentPickerListboxItem & {
  agent: TuiAgent | null
  label: string
  icon: ReactNode
  isChecked: boolean
  isDefault: boolean
}

type AgentDefaultContextMenuProps = {
  children: ReactNode
  isDefault: boolean
  onSetDefault?: () => void
}

function AgentIconLabel({ icon, label }: { icon: ReactNode; label: string }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center [&_img]:size-3.5 [&_svg]:size-3.5!">
        {icon}
      </span>
      <span className="truncate leading-none">{label}</span>
    </span>
  )
}

function AgentDefaultContextMenu({
  children,
  isDefault,
  onSetDefault
}: AgentDefaultContextMenuProps): ReactNode {
  if (!onSetDefault) {
    return children
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="z-[70]">
        <ContextMenuItem onSelect={onSetDefault} disabled={isDefault}>
          <Star className="size-3.5" />
          {isDefault
            ? translate('auto.components.agent.AgentCombobox.1b0d6965fa', 'Current default')
            : translate('auto.components.agent.AgentCombobox.9c6b59fe58', 'Set as default')}
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
  staleAgent,
  triggerClassName,
  onTriggerEnter,
  allowNarrowTrigger = false,
  allowBlankTerminal = true,
  emptyLabel
}: AgentComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const focusFrameRef = React.useRef<number | null>(null)
  const listboxId = useId()

  const selectedAgent = useMemo<AgentCatalogEntry | null>(
    () => (value ? (agents.find((agent) => agent.id === value) ?? null) : null),
    [agents, value]
  )
  // A set value that resolves to no catalog entry is a stale reference (the
  // agent was deleted or disabled). Never fall through to the Blank rendering —
  // that silent rebind is exactly the bug F3 closes. Self-heals once the value
  // resolves again (e.g. the catalog finishes loading).
  const isStale = value !== null && selectedAgent === null
  const selectedDefaultPreference = value ?? (allowBlankTerminal ? 'blank' : null)
  const filteredAgents = useMemo(() => searchAgentPickerEntries(agents, query), [agents, query])
  const blankMatchesQuery = useMemo(
    () => allowBlankTerminal && agentPickerBlankTerminalMatches(query),
    [allowBlankTerminal, query]
  )

  const rows = useMemo<AgentPickerRow[]>(() => {
    const list: AgentPickerRow[] = []
    if (blankMatchesQuery) {
      list.push({
        value: BLANK_VALUE,
        agent: null,
        label: translate('auto.components.agent.AgentCombobox.986f946354', 'Blank Terminal'),
        icon: <Terminal className="size-3.5" />,
        isChecked: value === null,
        isDefault: defaultAgent === 'blank'
      })
    }
    for (const agent of filteredAgents) {
      list.push({
        value: agent.id,
        agent: agent.id,
        label: agent.label,
        icon: <AgentIcon agent={agent.baseAgent ?? agent.id} />,
        isChecked: value === agent.id,
        isDefault: defaultAgent === agent.id
      })
    }
    return list
  }, [blankMatchesQuery, filteredAgents, value, defaultAgent])

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
        return
      }
      cancelFocusFrame()
      setQuery('')
    },
    [cancelFocusFrame]
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
        setOpen(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault()
        setQuery(event.key)
        setOpen(true)
      }
    },
    [open, onTriggerEnter]
  )

  const renderRow = useCallback(
    (row: AgentPickerRow): ReactNode => {
      const content = (
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Check
            className={cn(
              'size-4 shrink-0 text-foreground',
              row.isChecked ? 'opacity-100' : 'opacity-0'
            )}
          />
          <AgentIconLabel icon={row.icon} label={row.label} />
        </div>
      )
      if (!onSetDefault) {
        return content
      }
      return (
        // Why: z-[70] sits above PopoverContent's z-[60] so the right-click menu
        // renders in front of the still-open combobox popover instead of behind it.
        <ContextMenu>
          <ContextMenuTrigger asChild>{content}</ContextMenuTrigger>
          <ContextMenuContent className="z-[70]">
            <ContextMenuItem
              onSelect={() => onSetDefault(row.agent ?? 'blank')}
              disabled={row.isDefault}
            >
              <Star className="size-3.5" />
              {row.isDefault
                ? translate('auto.components.agent.AgentCombobox.1b0d6965fa', 'Current default')
                : translate('auto.components.agent.AgentCombobox.9c6b59fe58', 'Set as default')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    },
    [onSetDefault]
  )

  return (
    // Why: min-w-0 lets full-width form rows shrink; plain flex+items-center left the
    // trigger free to overflow its dialog column and look misaligned with Project/Name.
    <div className="min-w-0 w-full space-y-2">
      <div className="flex min-w-0 w-full items-center">
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
                aria-controls={listboxId}
                onKeyDown={handleTriggerKeyDown}
                className={cn(
                  // Why: callers sometimes pass `min-w-0` for grid layouts, but
                  // the compact trigger still needs room for "GitHub Copilot".
                  // py-0 clears the default size's py-2 so icon+label center in h-8/h-9.
                  'h-8 justify-between px-3 py-0 text-xs font-normal',
                  triggerClassName,
                  isStale && 'border-amber-500/60',
                  !allowNarrowTrigger && TRIGGER_MIN_WIDTH_CLASS
                )}
                data-agent-combobox-root="true"
              >
                {isStale ? (
                  <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                    {staleAgent ? <AgentIcon agent={staleAgent.baseAgent} /> : null}
                    <span className="truncate leading-none">
                      {staleAgent?.label ??
                        translate(
                          'auto.components.agent.AgentCombobox.unavailableAgent',
                          'Unavailable agent'
                        )}
                    </span>
                    <AlertTriangle className="size-3.5 text-amber-500" />
                  </span>
                ) : selectedAgent ? (
                  <AgentIconLabel
                    icon={<AgentIcon agent={selectedAgent.baseAgent ?? selectedAgent.id} />}
                    label={selectedAgent.label}
                  />
                ) : (
                  <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                    <Terminal className="size-3.5" />
                    <span className="truncate leading-none">
                      {emptyLabel ??
                        translate(
                          'auto.components.agent.AgentCombobox.986f946354',
                          'Blank Terminal'
                        )}
                    </span>
                  </span>
                )}
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
            <AgentPickerListbox
              items={rows}
              query={query}
              onQueryChange={setQuery}
              onSelect={(row) => handleSelect(row.agent)}
              renderItem={renderRow}
              initialActiveValue={value ?? (allowBlankTerminal ? BLANK_VALUE : null)}
              setInputNode={setInputNode}
              listboxId={listboxId}
              listAriaLabel={translate('auto.components.agent.AgentCombobox.listLabel', 'Agents')}
              searchPlaceholder={translate(
                'auto.components.agent.AgentCombobox.48c6a5a9b4',
                'Search agents...'
              )}
              emptyLabel={translate(
                'auto.components.agent.AgentCombobox.579c768bde',
                'No agents match your search.'
              )}
              footer={
                onOpenManageAgents ? (
                  <div className="border-t border-border">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={onOpenManageAgents}
                      onMouseDown={(event) => event.preventDefault()}
                      className="h-9 w-full justify-start rounded-none px-3 text-xs font-normal text-muted-foreground"
                    >
                      {translate('auto.components.agent.AgentCombobox.19522e25ee', 'Manage agents')}
                      <ArrowRight className="ml-auto size-3" />
                    </Button>
                  </div>
                ) : null
              }
            />
          </PopoverContent>
        </Popover>
      </div>
      {isStale ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {translate(
            'auto.components.agent.AgentCombobox.staleWarning',
            'This agent is unavailable. Choose another agent, or launches use a blank terminal.'
          )}
        </p>
      ) : null}
    </div>
  )
}
