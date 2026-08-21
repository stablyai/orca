import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Play } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import {
  getTerminalQuickCommandBody,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { getAgentLabel } from '@/lib/agent-catalog'
import { TabBarQuickCommandItem } from './TabBarQuickCommandItem'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { useTabBarQuickCommandsShortcut } from './tab-bar-quick-commands-shortcut'
import { TabBarQuickCommandAddActions } from './TabBarQuickCommandAddActions'
import { TabBarQuickCommandHostLoadStatus } from './TabBarQuickCommandHostLoadStatus'
import { searchHostedTerminalQuickCommands } from './hosted-terminal-quick-command-search'
import { useTabBarQuickCommandSearchInput } from './use-tab-bar-quick-command-search-input'
import type {
  HostedTerminalQuickCommand,
  TerminalQuickCommandHost
} from '@/hooks/use-terminal-quick-command-hosts'
type TabBarQuickCommandsMenuProps = {
  repoCommands: readonly HostedTerminalQuickCommand[]
  globalCommands: readonly HostedTerminalQuickCommand[]
  mostRecent: HostedTerminalQuickCommand | null
  addHosts: readonly TerminalQuickCommandHost[]
  hostLoadFailed: boolean
  hostOwnershipPending: boolean
  onAddCommand: (hostId: TerminalQuickCommandHost['hostId']) => void
  onDeleteCommand: (entry: HostedTerminalQuickCommand) => void
  onEditCommand: (entry: HostedTerminalQuickCommand) => void
  onMenuOpen: () => void
  onRunCommand: (entry: HostedTerminalQuickCommand) => void
}

export function TabBarQuickCommandsMenu({
  repoCommands,
  globalCommands,
  mostRecent,
  addHosts,
  hostLoadFailed,
  hostOwnershipPending,
  onAddCommand,
  onDeleteCommand,
  onEditCommand,
  onMenuOpen,
  onRunCommand
}: TabBarQuickCommandsMenuProps): React.JSX.Element {
  const openMenuShortcutCombos = useShortcutKeyComboDetails('tab.openQuickCommandsMenu')
  const [menuOpen, setMenuOpen] = useState(false)
  const [moreCommandsTooltipOpen, setMoreCommandsTooltipOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValueOverride, setCommandValueOverride] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const commandListRef = useRef<HTMLDivElement | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const menuImeEnter = useImeEnterGestureOwnership()
  // Why: closing restores focus to the chevron for accessibility, but that
  // focus restoration should not immediately reopen its tooltip.
  const suppressMoreCommandsTooltipRef = useRef(false)
  const showSearch = repoCommands.length + globalCommands.length > 1
  const filteredRepoCommands = useMemo(
    () => searchHostedTerminalQuickCommands(repoCommands, query),
    [repoCommands, query]
  )
  const filteredGlobalCommands = useMemo(
    () => searchHostedTerminalQuickCommands(globalCommands, query),
    [globalCommands, query]
  )
  const filteredVisibleCommands = useMemo(
    () => [...filteredRepoCommands, ...filteredGlobalCommands],
    [filteredRepoCommands, filteredGlobalCommands]
  )
  const commandValue = useMemo(() => {
    const activeValue =
      !query.trim() &&
      mostRecent &&
      filteredVisibleCommands.some((entry) => entry.key === mostRecent.key)
        ? mostRecent.key
        : (filteredVisibleCommands[0]?.key ?? '')
    if (
      commandValueOverride &&
      filteredVisibleCommands.some((entry) => entry.key === commandValueOverride)
    ) {
      return commandValueOverride
    }
    return activeValue
  }, [commandValueOverride, filteredVisibleCommands, mostRecent, query])
  const selectedCommand = useMemo(
    () => filteredVisibleCommands.find((entry) => entry.key === commandValue) ?? null,
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
  const handleMoreCommandsTooltipOpenChange = useCallback((next: boolean): void => {
    if (next && suppressMoreCommandsTooltipRef.current) {
      return
    }
    setMoreCommandsTooltipOpen(next)
  }, [])
  const allowMoreCommandsTooltip = useCallback((): void => {
    suppressMoreCommandsTooltipRef.current = false
  }, [])
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      setMenuOpen(next)
      if (next) {
        onMenuOpen()
        suppressMoreCommandsTooltipRef.current = false
        setMoreCommandsTooltipOpen(false)
        setCommandValueOverride(null)
        return
      }
      suppressMoreCommandsTooltipRef.current = true
      setMoreCommandsTooltipOpen(false)
      cancelFocusFrame()
      setQuery('')
      setCommandValueOverride(null)
    },
    [cancelFocusFrame, onMenuOpen]
  )
  const closeMenu = useCallback((): void => {
    handleOpenChange(false)
  }, [handleOpenChange])
  useTabBarQuickCommandsShortcut({ menuOpen, onOpenChange: handleOpenChange })
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
    (entry: HostedTerminalQuickCommand): void => {
      closeMenu()
      onRunCommand(entry)
    },
    [closeMenu, onRunCommand]
  )
  const searchInput = useTabBarQuickCommandSearchInput({
    commandListRef,
    commandValue,
    filteredCommands: filteredVisibleCommands,
    getCommandId: (entry) => entry.key,
    onCommandValueChange: setCommandValueOverride,
    onRun: runAndClose,
    selectedCommand
  })
  const moreCommandsLabel = translate(
    'auto.components.tab.bar.TabBarQuickCommandsButton.b82e237a4b',
    'More quick commands'
  )
  const splitButtonClass =
    'my-auto flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border/60 text-muted-foreground'
  const innerButtonBase =
    'flex items-center bg-transparent leading-none text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
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
                    { value0: mostRecent.command.label }
                  )
                : translate(
                    'auto.components.tab.bar.TabBarQuickCommandsButton.85482c57bc',
                    'Run quick command'
                  )
            }
          >
            <Play className="size-3 shrink-0" fill="currentColor" strokeWidth={0} />
            <span className="max-w-[160px] truncate text-[12px] font-medium">
              {mostRecent?.command.label ??
                translate('auto.components.tab.bar.TabBarQuickCommandsButton.7b1c9d6ae1', 'Run')}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {mostRecent
            ? isTerminalAgentQuickCommand(mostRecent.command)
              ? translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.77ac113df0',
                  'Start {{value0}}: {{value1}}',
                  {
                    value0: getAgentLabel(mostRecent.command.agent),
                    value1: getTerminalQuickCommandBody(mostRecent.command)
                  }
                )
              : translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.37e1bb90ce',
                  'Run: {{value0}}',
                  { value0: getTerminalQuickCommandBody(mostRecent.command) }
                )
            : translate(
                'auto.components.tab.bar.TabBarQuickCommandsButton.85482c57bc',
                'Run quick command'
              )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleOpenChange}>
        <Tooltip open={moreCommandsTooltipOpen} onOpenChange={handleMoreCommandsTooltipOpenChange}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  innerButtonBase,
                  'justify-center rounded-l-none rounded-r-md border-l border-border/60 px-1'
                )}
                aria-label={moreCommandsLabel}
                onPointerEnter={allowMoreCommandsTooltip}
                onBlur={allowMoreCommandsTooltip}
              >
                <ChevronDown className="size-3" strokeWidth={2.5} />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            <span className="inline-flex items-center gap-1.5">
              <span>{moreCommandsLabel}</span>
              {openMenuShortcutCombos.map((shortcut, index) => (
                <ShortcutKeyCombo
                  key={`${shortcut.keys.join('-')}-${index}`}
                  keys={shortcut.keys}
                  doubleTap={shortcut.doubleTap}
                  className="gap-0.5"
                  keyCapClassName="min-w-0 border-background/30 bg-background/10 px-1 py-0 text-[10px] text-background shadow-none"
                  separatorClassName="mx-0 text-[10px] text-background/70"
                />
              ))}
            </span>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={6}
          className="w-80 p-0"
          onCompositionStart={() => {
            if (!showSearch) {
              menuImeEnter.setComposing(true)
            }
          }}
          onCompositionEnd={() => {
            if (!showSearch) {
              menuImeEnter.setComposing(false)
            }
          }}
          onKeyDown={(event) => {
            if (!showSearch && menuImeEnter.ownsKeyDown(event)) {
              return
            }
            if (event.key !== 'Enter' || showSearch || filteredVisibleCommands.length !== 1) {
              return
            }
            event.preventDefault()
            runAndClose(filteredVisibleCommands[0])
          }}
          onKeyUp={(event) => {
            if (!showSearch) {
              menuImeEnter.onKeyUp(event)
            }
          }}
          onBlur={menuImeEnter.reset}
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
                onCompositionStart={searchInput.onCompositionStart}
                onCompositionEnd={searchInput.onCompositionEnd}
                onKeyDown={searchInput.onKeyDown}
                onKeyUp={searchInput.onKeyUp}
                onBlur={searchInput.onBlur}
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
              {filteredRepoCommands.map((entry) => (
                <TabBarQuickCommandItem
                  key={entry.key}
                  entry={entry}
                  showHostLabel={addHosts.length > 1}
                  onRun={() => runAndClose(entry)}
                  onEdit={() => {
                    closeMenu()
                    onEditCommand(entry)
                  }}
                  onDelete={() => {
                    closeMenu()
                    onDeleteCommand(entry)
                  }}
                />
              ))}
              {filteredRepoCommands.length > 0 && filteredGlobalCommands.length > 0 ? (
                <CommandSeparator className="my-1" />
              ) : null}
              {filteredGlobalCommands.map((entry) => (
                <TabBarQuickCommandItem
                  key={entry.key}
                  entry={entry}
                  showHostLabel={addHosts.length > 1}
                  onRun={() => runAndClose(entry)}
                  onEdit={() => {
                    closeMenu()
                    onEditCommand(entry)
                  }}
                  onDelete={() => {
                    closeMenu()
                    onDeleteCommand(entry)
                  }}
                />
              ))}
            </CommandList>
            {hostOwnershipPending ? (
              <TabBarQuickCommandHostLoadStatus failed={hostLoadFailed} />
            ) : (
              <TabBarQuickCommandAddActions
                hosts={addHosts}
                onAdd={(hostId) => {
                  closeMenu()
                  onAddCommand(hostId)
                }}
              />
            )}
          </Command>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
