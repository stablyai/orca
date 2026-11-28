import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Command, CommandInput } from '@/components/ui/command'
import { DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { TabBarQuickCommandsList } from './TabBarQuickCommandsList'
import { TabBarQuickCommandItem } from './TabBarQuickCommandItem'
import { useTranslate } from '@/i18n/use-translate'
import { useImeEnterGestureOwnership } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { TabBarQuickCommandAddActions } from './TabBarQuickCommandAddActions'
import { TabBarQuickCommandHostLoadStatus } from './TabBarQuickCommandHostLoadStatus'
import { searchHostedTerminalQuickCommands } from './hosted-terminal-quick-command-search'
import { useTabBarQuickCommandSearchInput } from './use-tab-bar-quick-command-search-input'
import type {
  HostedTerminalQuickCommand,
  TerminalQuickCommandHost
} from '@/lib/terminal/quick-commands/use-terminal-quick-command-hosts'

export function TabBarQuickCommandsMenuContent({
  isFocused,
  menuOpen,
  repoCommands,
  globalCommands,
  mostRecent,
  addHosts,
  hostLoadFailed,
  hostOwnershipPending,
  triggerRef,
  focusBeforeOpenRef,
  interactedOutsideRef,
  onCloseMenu,
  onRunAndClose,
  onAddCommand,
  onEditCommand,
  onDeleteCommand
}: {
  isFocused: boolean
  menuOpen: boolean
  repoCommands: readonly HostedTerminalQuickCommand[]
  globalCommands: readonly HostedTerminalQuickCommand[]
  mostRecent: HostedTerminalQuickCommand | null
  addHosts: readonly TerminalQuickCommandHost[]
  hostLoadFailed: boolean
  hostOwnershipPending: boolean
  triggerRef: React.RefObject<HTMLButtonElement | null>
  focusBeforeOpenRef: React.RefObject<HTMLElement | null>
  interactedOutsideRef: React.RefObject<boolean>
  onCloseMenu: () => void
  onRunAndClose: (entry: HostedTerminalQuickCommand) => void
  onAddCommand: (hostId: TerminalQuickCommandHost['hostId']) => void
  onEditCommand: (entry: HostedTerminalQuickCommand) => void
  onDeleteCommand: (entry: HostedTerminalQuickCommand) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [commandValueOverride, setCommandValueOverride] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const commandListRef = useRef<HTMLDivElement | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const menuImeEnter = useImeEnterGestureOwnership()
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

  useEffect(() => {
    if (menuOpen) {
      setCommandValueOverride(null)
      if (!showSearch) {
        return
      }
      // Override Radix surface focus so Enter can run the highlighted search result.
      focusSearchInput()
      return cancelFocusFrame
    }
    cancelFocusFrame()
    setQuery('')
    setCommandValueOverride(null)
    return undefined
  }, [cancelFocusFrame, focusSearchInput, menuOpen, showSearch])

  const searchInput = useTabBarQuickCommandSearchInput({
    commandListRef,
    commandValue,
    filteredCommands: filteredVisibleCommands,
    getCommandId: (entry) => entry.key,
    onCommandValueChange: setCommandValueOverride,
    onRun: onRunAndClose,
    selectedCommand
  })

  // Why: cmdk only tracks mounted items; selection belongs to the full command list.
  const attachActiveCommand = useCallback((element: HTMLDivElement | null): void => {
    for (const target of [searchInputRef.current, commandListRef.current]) {
      if (element) {
        target?.setAttribute('aria-activedescendant', element.id)
      } else {
        target?.removeAttribute('aria-activedescendant')
      }
    }
  }, [])

  const renderCommand = (entry: HostedTerminalQuickCommand): React.JSX.Element => (
    <TabBarQuickCommandItem
      key={entry.key}
      entry={entry}
      showHostLabel={addHosts.length > 1}
      selected={entry.key === commandValue}
      position={filteredVisibleCommands.indexOf(entry) + 1}
      totalCount={filteredVisibleCommands.length}
      onHighlight={() => setCommandValueOverride(entry.key)}
      onActiveElementChange={attachActiveCommand}
      onRun={() => onRunAndClose(entry)}
      onEdit={() => {
        onCloseMenu()
        onEditCommand(entry)
      }}
      onDelete={() => {
        onCloseMenu()
        onDeleteCommand(entry)
      }}
    />
  )

  return (
    <DropdownMenuContent
      align="end"
      side="bottom"
      sideOffset={6}
      className="w-120 max-w-[calc(100vw-1rem)]"
      onInteractOutside={() => {
        interactedOutsideRef.current = true
      }}
      onCloseAutoFocus={(event) => {
        const focusBeforeOpen = focusBeforeOpenRef.current
        focusBeforeOpenRef.current = null
        if (!isFocused) {
          event.preventDefault()
          return
        }
        // Why: a narrow strip hides the trigger, so Radix can't return focus there; restore where the shortcut fired unless the user clicked away.
        if (
          !interactedOutsideRef.current &&
          triggerRef.current?.checkVisibility({ visibilityProperty: true }) === false
        ) {
          event.preventDefault()
          focusBeforeOpen?.focus()
        }
      }}
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
        onRunAndClose(filteredVisibleCommands[0])
      }}
      onBlur={menuImeEnter.reset}
    >
      <Command shouldFilter={false} surface="inline">
        {showSearch ? (
          <CommandInput
            ref={searchInputRef}
            autoFocus
            placeholder={t(
              'auto.components.tab.bar.TabBarQuickCommandsButton.f3a8c2d1e7',
              'Search quick commands...'
            )}
            value={query}
            onValueChange={(nextQuery) => {
              // Reset user selection on query changes so the best new match becomes active.
              setCommandValueOverride(null)
              setQuery(nextQuery)
            }}
            onKeyDown={searchInput.onKeyDown}
            className="h-9 py-2 text-[12px]"
            wrapperClassName="border-b border-border/50 px-2"
            iconClassName="h-3.5 w-3.5"
          />
        ) : null}
        <TabBarQuickCommandsList
          commands={filteredVisibleCommands}
          firstGlobalCommand={
            filteredRepoCommands.length > 0 ? filteredGlobalCommands[0] : undefined
          }
          selectedKey={commandValue}
          query={query}
          commandListRef={commandListRef}
          renderCommand={renderCommand}
        />
        {hostOwnershipPending ? (
          <TabBarQuickCommandHostLoadStatus failed={hostLoadFailed} />
        ) : (
          <TabBarQuickCommandAddActions
            hosts={addHosts}
            onAdd={(hostId) => {
              onCloseMenu()
              onAddCommand(hostId)
            }}
          />
        )}
      </Command>
    </DropdownMenuContent>
  )
}
