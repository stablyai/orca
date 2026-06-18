import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Pencil, Play, Trash2 } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  getTerminalQuickCommandBody,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  getTerminalQuickCommandPickerValue,
  searchTerminalQuickCommands
} from '@/lib/terminal-quick-command-search'
type TabBarQuickCommandsMenuProps = {
  repoCommands: readonly TerminalQuickCommand[]
  globalCommands: readonly TerminalQuickCommand[]
  mostRecent: TerminalQuickCommand | null
  onAddCommand: () => void
  onDeleteCommand: (command: TerminalQuickCommand) => void
  onEditCommand: (command: TerminalQuickCommand) => void
  onRunCommand: (command: TerminalQuickCommand) => void
}
export function TabBarQuickCommandsMenu({
  repoCommands,
  globalCommands,
  mostRecent,
  onAddCommand,
  onDeleteCommand,
  onEditCommand,
  onRunCommand
}: TabBarQuickCommandsMenuProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValueOverride, setCommandValueOverride] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const commandListRef = useRef<HTMLDivElement | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const totalVisible = repoCommands.length + globalCommands.length
  const showSearch = totalVisible > 1
  const filteredRepoCommands = useMemo(
    () => searchTerminalQuickCommands(repoCommands, query),
    [repoCommands, query]
  )
  const filteredGlobalCommands = useMemo(
    () => searchTerminalQuickCommands(globalCommands, query),
    [globalCommands, query]
  )
  const filteredVisibleCommands = useMemo(
    () => [...filteredRepoCommands, ...filteredGlobalCommands],
    [filteredRepoCommands, filteredGlobalCommands]
  )
  const commandValue = useMemo(() => {
    const activeValue = getTerminalQuickCommandPickerValue({
      preferredCommandId: mostRecent?.id ?? null,
      filteredCommands: filteredVisibleCommands,
      rawQuery: query
    })
    if (
      commandValueOverride &&
      filteredVisibleCommands.some((command) => command.id === commandValueOverride)
    ) {
      return commandValueOverride
    }
    return activeValue
  }, [commandValueOverride, filteredVisibleCommands, mostRecent?.id, query])
  const selectedCommand = useMemo(
    () => filteredVisibleCommands.find((command) => command.id === commandValue) ?? null,
    [commandValue, filteredVisibleCommands]
  )
  const cancelFocusFrame = useCallback((): void => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [])
  const focusSearchInput = useCallback((): void => {
    cancelFocusFrame()
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      const searchInput = searchInputRef.current
      if (!searchInput) {
        return
      }
      searchInput.focus()
      const end = searchInput.value.length
      searchInput.setSelectionRange(end, end)
    })
  }, [cancelFocusFrame])
  const handleOpenChange = (next: boolean): void => {
    setMenuOpen(next)
    if (next) {
      setCommandValueOverride(null)
      return
    }
    cancelFocusFrame()
    setQuery('')
    setCommandValueOverride(null)
  }
  useEffect(() => {
    if (!menuOpen || !showSearch) {
      return
    }
    // Why: Radix focuses the menu surface by default; search-first UX needs
    // the input ready so Enter can run the highlighted command.
    focusSearchInput()
    return cancelFocusFrame
  }, [cancelFocusFrame, focusSearchInput, menuOpen, showSearch])
  const runAndClose = useCallback(
    (command: TerminalQuickCommand): void => {
      setMenuOpen(false)
      onRunCommand(command)
    },
    [onRunCommand]
  )
  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && selectedCommand) {
        // Why: cmdk does not submit the highlighted item from CommandInput
        // inside a DropdownMenu — mirror other searchable menus and run it here.
        event.preventDefault()
        event.stopPropagation()
        runAndClose(selectedCommand)
        return
      }
      if (
        (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
        filteredVisibleCommands.length > 0
      ) {
        event.preventDefault()
        event.stopPropagation()
        const currentIndex = filteredVisibleCommands.findIndex(
          (command) => command.id === commandValue
        )
        const startIndex = Math.max(currentIndex, 0)
        const direction = event.key === 'ArrowDown' ? 1 : -1
        let nextIndex = startIndex + direction
        if (nextIndex < 0) {
          nextIndex = filteredVisibleCommands.length - 1
        } else if (nextIndex >= filteredVisibleCommands.length) {
          nextIndex = 0
        }
        setCommandValueOverride(filteredVisibleCommands[nextIndex].id)
        requestAnimationFrame(() => {
          commandListRef.current
            ?.querySelector('[cmdk-item][data-selected="true"]')
            ?.scrollIntoView({ block: 'nearest' })
        })
        return
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        // Why: keep printable keys in the search field instead of Radix typeahead,
        // while letting Escape/Tab and system shortcuts keep their menu semantics.
        event.stopPropagation()
      }
    },
    [commandValue, filteredVisibleCommands, runAndClose, selectedCommand]
  )
  const splitButtonClass =
    'my-auto flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border/60 text-muted-foreground'
  const innerButtonBase =
    'flex items-center bg-transparent leading-none text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
  const renderItem = (command: TerminalQuickCommand): React.JSX.Element => (
    <CommandItem
      key={command.id}
      value={command.id}
      onSelect={() => runAndClose(command)}
      className="group/qc mx-1 my-0.5 items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
    >
      {isTerminalAgentQuickCommand(command) ? (
        <span className="shrink-0 text-muted-foreground">
          <AgentIcon agent={command.agent} size={12} />
        </span>
      ) : (
        <Play
          className="size-3 shrink-0 text-muted-foreground"
          fill="currentColor"
          strokeWidth={0}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{command.label}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {isTerminalAgentQuickCommand(command)
            ? `${getAgentLabel(command.agent)}: ${command.prompt}`
            : command.command}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 can-hover:opacity-0 transition-opacity group-hover/qc:opacity-100 group-data-[selected=true]/qc:opacity-100">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            setMenuOpen(false)
            onEditCommand(command)
          }}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={translate(
            'auto.components.tab.bar.TabBarQuickCommandsButton.15529ede69',
            'Edit {{value0}}',
            { value0: command.label }
          )}
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            setMenuOpen(false)
            onDeleteCommand(command)
          }}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
          aria-label={translate(
            'auto.components.tab.bar.TabBarQuickCommandsButton.196593b6a9',
            'Remove {{value0}}',
            { value0: command.label }
          )}
        >
          <Trash2 className="size-3" />
        </button>
      </span>
    </CommandItem>
  )
  return (
    <div className={splitButtonClass}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => mostRecent && runAndClose(mostRecent)}
            disabled={!mostRecent}
            className={cn(innerButtonBase, 'gap-1.5 rounded-l-md rounded-r-none px-1.5')}
            aria-label={
              mostRecent
                ? translate(
                    'auto.components.tab.bar.TabBarQuickCommandsButton.b775303755',
                    'Run quick command: {{value0}}',
                    { value0: mostRecent.label }
                  )
                : translate(
                    'auto.components.tab.bar.TabBarQuickCommandsButton.85482c57bc',
                    'Run quick command'
                  )
            }
          >
            <Play className="size-3 shrink-0" fill="currentColor" strokeWidth={0} />
            <span className="max-w-[160px] truncate text-[12px] font-medium">
              {mostRecent?.label ??
                translate('auto.components.tab.bar.TabBarQuickCommandsButton.7b1c9d6ae1', 'Run')}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {mostRecent
            ? isTerminalAgentQuickCommand(mostRecent)
              ? translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.77ac113df0',
                  'Start {{value0}}: {{value1}}',
                  {
                    value0: getAgentLabel(mostRecent.agent),
                    value1: getTerminalQuickCommandBody(mostRecent)
                  }
                )
              : translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.37e1bb90ce',
                  'Run: {{value0}}',
                  { value0: getTerminalQuickCommandBody(mostRecent) }
                )
            : translate(
                'auto.components.tab.bar.TabBarQuickCommandsButton.85482c57bc',
                'Run quick command'
              )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              innerButtonBase,
              'justify-center rounded-l-none rounded-r-md border-l border-border/60 px-1'
            )}
            aria-label={translate(
              'auto.components.tab.bar.TabBarQuickCommandsButton.b82e237a4b',
              'More quick commands'
            )}
          >
            <ChevronDown className="size-3" strokeWidth={2.5} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={6}
          className="w-72 p-0"
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || showSearch || filteredVisibleCommands.length !== 1) {
              return
            }
            event.preventDefault()
            runAndClose(filteredVisibleCommands[0])
          }}
        >
          <Command
            shouldFilter={false}
            loop
            value={commandValue}
            onValueChange={setCommandValueOverride}
            className="bg-transparent"
          >
            {showSearch ? (
              <CommandInput
                ref={searchInputRef}
                autoFocus
                placeholder={translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.f3a8c2d1e7',
                  'Search quick commands...'
                )}
                value={query}
                onValueChange={(nextQuery) => {
                  // Why: a new query changes the filtered list, so keyboard
                  // selection should jump to the best match immediately.
                  setCommandValueOverride(null)
                  setQuery(nextQuery)
                }}
                onKeyDown={handleSearchKeyDown}
                className="h-9 py-2 text-[12px]"
                wrapperClassName="border-b border-border/50 px-2"
                iconClassName="h-3.5 w-3.5"
              />
            ) : null}
            <CommandList ref={commandListRef} className="max-h-72 py-1">
              {filteredVisibleCommands.length === 0 ? (
                <CommandEmpty className="py-4 text-center text-[11px]">
                  {query.trim()
                    ? translate(
                        'auto.components.tab.bar.TabBarQuickCommandsButton.b4e7f9a2c1',
                        'No commands match'
                      )
                    : translate(
                        'auto.components.tab.bar.TabBarQuickCommandsButton.20bbd75896',
                        'No commands'
                      )}
                </CommandEmpty>
              ) : null}
              {filteredRepoCommands.map(renderItem)}
              {filteredRepoCommands.length > 0 && filteredGlobalCommands.length > 0 ? (
                <CommandSeparator className="my-1" />
              ) : null}
              {filteredGlobalCommands.map(renderItem)}
            </CommandList>
            <div className="border-t border-border/50 p-1">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onAddCommand()
                }}
                className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Play className="size-3.5" />
                {translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.a2c7a33831',
                  'Command'
                )}
              </button>
            </div>
          </Command>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
