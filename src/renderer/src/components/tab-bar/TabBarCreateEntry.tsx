import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { useRuntimeFileListForWorktree } from '../quick-open-file-list'
import {
  createTabEntryAllowAbsolutePathsSelector,
  getTabEntryOptions,
  isTabEntryAbsolutePathLike,
  type TabCreateEntryArgs
} from './tab-create-entry-action'
import {
  findMatchingTabAgentLaunchOptions,
  type TabAgentLaunchOption
} from './tab-agent-launch-options'
import {
  findMatchingTabCreateMenuOptions,
  type TabCreateMenuOption
} from './tab-create-menu-options'
import {
  getActiveOptionId,
  isActiveEntryOption,
  type ActiveOption
} from './tab-create-entry-active-option'
import {
  EntryActionRow,
  EntryStatusRow,
  RESULT_LISTBOX_ID,
  resultOptionDomId
} from './TabBarCreateEntryRow'
import { dropFileEntriesCoveredByTabResults } from './open-tab-entry-dedupe'
import { activateOpenTabSearchResult } from './open-tab-selection-routing'
import { useOpenTabSearch } from './use-open-tab-search'
import type { TuiAgent } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { useAppStore } from '@/store'

// Leads with tabs: the omnibox now jumps to open tabs before it creates anything.
function omniboxPlaceholder(): string {
  return translate(
    'auto.components.tab.bar.TabBarCreateEntry.0e5b7a3f16',
    'Search open tabs, files, URLs, agents…'
  )
}

const EMPTY_AGENT_OPTIONS: readonly TabAgentLaunchOption[] = []
const EMPTY_MENU_OPTIONS: readonly TabCreateMenuOption[] = []

type TabBarCreateEntryProps = {
  agentOptions?: readonly TabAgentLaunchOption[]
  groupId: string
  menuOpen: boolean
  menuOptions?: readonly TabCreateMenuOption[]
  onDidOpenEntry?: () => void
  onLaunchAgent?: (agent: TuiAgent) => void
  onOpenDefaultTerminal?: () => void
  onOpenEntry?: (args: TabCreateEntryArgs) => Promise<void>
  onQueryChange?: (query: string) => void
  /** Runs after the menu closes, so the tab jumped to actually takes focus. */
  onQueueSwitchFocus?: (focus: () => void) => void
  onSelectMenuOption?: (option: TabCreateMenuOption) => void
  worktreeId: string
}

export default function TabBarCreateEntry({
  agentOptions = EMPTY_AGENT_OPTIONS,
  groupId,
  menuOpen,
  menuOptions = EMPTY_MENU_OPTIONS,
  onDidOpenEntry,
  onLaunchAgent,
  onOpenDefaultTerminal,
  onOpenEntry,
  onQueryChange,
  onQueueSwitchFocus,
  onSelectMenuOption,
  worktreeId
}: TabBarCreateEntryProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [selectedOptionQuery, setSelectedOptionQuery] = useState(query)
  const [lastMenuOpen, setLastMenuOpen] = useState(menuOpen)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileList = useRuntimeFileListForWorktree({ enabled: menuOpen, worktreeId })
  const tabResults = useOpenTabSearch({ enabled: menuOpen, query, worktreeId })
  const shouldResolveAbsolutePaths = menuOpen && isTabEntryAbsolutePathLike(query.trim())
  const allowAbsolutePathsSelector = useMemo(
    () =>
      createTabEntryAllowAbsolutePathsSelector(worktreeId, {
        skip: !shouldResolveAbsolutePaths
      }),
    [shouldResolveAbsolutePaths, worktreeId]
  )
  const allowAbsolutePaths = useAppStore(allowAbsolutePathsSelector)
  const localPlatform = getRendererAppPlatform() === 'win32' ? 'windows' : 'posix'

  // Why: once ArrowDown moves focus into the static menu list, ArrowUp on the
  // first item should return to the search box so the keyboard trip isn't
  // one-way. Capture phase beats Radix's roving-focus handler.
  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const input = inputRef.current
    const menu = input?.closest<HTMLElement>('[role="menu"]')
    if (!input || !menu) {
      return
    }
    const handleMenuKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowUp') {
        return
      }
      const firstItem = menu.querySelector(
        '[role="menuitem"]:not([data-disabled]):not([aria-disabled="true"])'
      )
      if (firstItem && document.activeElement === firstItem) {
        event.preventDefault()
        event.stopPropagation()
        input.focus()
      }
    }
    menu.addEventListener('keydown', handleMenuKeyDown, true)
    return () => menu.removeEventListener('keydown', handleMenuKeyDown, true)
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const focusFrame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(focusFrame)
  }, [menuOpen])

  const matchingMenuOptions = useMemo(
    () => findMatchingTabCreateMenuOptions(query, menuOptions),
    [menuOptions, query]
  )
  const options = useMemo(() => {
    const entryOptions = dropFileEntriesCoveredByTabResults(
      getTabEntryOptions(query, fileList, 4, {
        allowAbsolutePaths,
        localPlatform
      }),
      tabResults
    )
    if (matchingMenuOptions.length === 0) {
      return entryOptions
    }
    // Why: a matched create-menu action should win over a generic new-file fallback.
    return entryOptions.filter((option) => option.classification.kind !== 'new-file')
  }, [allowAbsolutePaths, fileList, localPlatform, matchingMenuOptions.length, query, tabResults])
  const matchingAgentOptions = useMemo(
    () => findMatchingTabAgentLaunchOptions(query, agentOptions),
    [agentOptions, query]
  )

  if (lastMenuOpen !== menuOpen) {
    setLastMenuOpen(menuOpen)
    if (!menuOpen) {
      setQuery('')
      setPending(false)
      setError(null)
      setSwitchError(null)
      setSelectedOptionId(null)
    }
  }

  const disabled = !onOpenEntry
  const hasQuery = query.trim().length > 0
  const activeOptions: ActiveOption[] = [
    ...tabResults.map((option) => ({
      kind: 'tab' as const,
      option
    })),
    ...matchingMenuOptions.map((option) => ({
      kind: 'menu' as const,
      option
    })),
    ...matchingAgentOptions.map((option) => ({
      kind: 'agent' as const,
      option
    })),
    ...options.filter(isActiveEntryOption).map((option) => ({
      kind: 'entry' as const,
      option
    }))
  ]
  const topOptionId = activeOptions.length > 0 ? getActiveOptionId(activeOptions[0]) : null
  if (selectedOptionQuery !== query) {
    setSelectedOptionQuery(query)
    setSelectedOptionId(topOptionId)
  } else if (selectedOptionId === null && topOptionId !== null) {
    // Why pin the top row by id: the tab search defers the query, so tab rows
    // arrive a render later and would otherwise slide under an index-kept highlight.
    setSelectedOptionId(topOptionId)
  }
  const selectedOptionIndex = selectedOptionId
    ? activeOptions.findIndex((option) => getActiveOptionId(option) === selectedOptionId)
    : -1
  const activeSelectedIndex = Math.max(selectedOptionIndex, 0)
  const selectedActiveOption = activeOptions[activeSelectedIndex]
  const statusOption = options.find(
    (option) => option.classification.kind === 'empty' || option.classification.kind === 'blocked'
  )
  const statusMessage =
    statusOption?.classification.kind === 'empty' || statusOption?.classification.kind === 'blocked'
      ? statusOption.classification.message
      : omniboxPlaceholder()

  const submitOption = (option?: ActiveOption) => {
    if (disabled || pending) {
      return
    }
    const selectedOption = option ?? selectedActiveOption ?? null
    if (!selectedOption) {
      if (!hasQuery && onOpenDefaultTerminal) {
        onOpenDefaultTerminal()
        onDidOpenEntry?.()
        return
      }
      setError(statusMessage)
      return
    }
    if (selectedOption.kind === 'tab') {
      const outcome = activateOpenTabSearchResult(selectedOption.option)
      if (outcome.status === 'failed') {
        setSwitchError(outcome.message)
        return
      }
      if (outcome.focus) {
        onQueueSwitchFocus?.(outcome.focus)
      }
      onDidOpenEntry?.()
      return
    }
    if (selectedOption.kind === 'menu') {
      onSelectMenuOption?.(selectedOption.option)
      onDidOpenEntry?.()
      return
    }
    if (selectedOption.kind === 'agent') {
      onLaunchAgent?.(selectedOption.option.agent)
      onDidOpenEntry?.()
      return
    }
    setPending(true)
    setError(null)
    void onOpenEntry({
      query,
      worktreeId,
      groupId,
      fileList,
      classification: selectedOption.option.classification
    })
      .then(() => {
        onDidOpenEntry?.()
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        setPending(false)
      })
  }

  return (
    <form
      className="pb-1"
      onSubmit={(event) => {
        event.preventDefault()
        submitOption()
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (activeOptions.length > 0) {
            event.preventDefault()
            event.stopPropagation()
            const delta = event.key === 'ArrowDown' ? 1 : -1
            const nextIndex =
              (activeSelectedIndex + delta + activeOptions.length) % activeOptions.length
            setSelectedOptionId(getActiveOptionId(activeOptions[nextIndex]))
            return
          }
          // Why: with no result rows the static create/agent items render below;
          // move focus into that Radix menu list so it stays keyboard-navigable
          // from the search box instead of trapping focus in the input.
          if (
            focusMenuItemAtEdge(event.currentTarget, event.key === 'ArrowDown' ? 'first' : 'last')
          ) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
        }
        if (event.key !== 'Escape') {
          event.stopPropagation()
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="-mx-1 flex items-center px-3">
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value
            // Why: the parent query only changes in response to typing, so publish
            // it in this event rather than a later effect after the render commits.
            setQuery(nextQuery)
            onQueryChange?.(nextQuery)
            setError(null)
            setSwitchError(null)
          }}
          disabled={disabled}
          role="combobox"
          aria-expanded={activeOptions.length > 0}
          aria-controls={RESULT_LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={
            activeOptions.length > 0 && !error ? resultOptionDomId(activeSelectedIndex) : undefined
          }
          aria-label={omniboxPlaceholder()}
          aria-invalid={error ? true : undefined}
          placeholder={omniboxPlaceholder()}
          className="h-9 rounded-none border-0 bg-transparent px-0 text-xs font-normal text-foreground shadow-none placeholder:font-normal placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 aria-invalid:border-0 aria-invalid:ring-0 md:text-xs dark:bg-transparent"
        />
      </div>
      {/* Above the list, not instead of it: a stale switch target must not wipe
          the rows the user can still act on. */}
      {switchError ? (
        <div className="mt-1 px-1">
          <EntryStatusRow message={switchError} />
        </div>
      ) : null}
      {error || activeOptions.length > 0 || hasQuery ? (
        <div
          className="mt-1 space-y-0.5 px-1"
          id={RESULT_LISTBOX_ID}
          role={activeOptions.length > 0 && !error ? 'listbox' : undefined}
        >
          {error ? (
            <EntryStatusRow message={error} />
          ) : activeOptions.length > 0 ? (
            activeOptions.map((option, index) => (
              <EntryActionRow
                key={getActiveOptionId(option)}
                id={resultOptionDomId(index)}
                option={option}
                selected={index === activeSelectedIndex}
                onClick={() => submitOption(option)}
              />
            ))
          ) : (
            <EntryStatusRow loading={fileList.loading} message={statusMessage} />
          )}
        </div>
      ) : null}
    </form>
  )
}

// Moves keyboard focus to the first/last enabled item of the enclosing Radix
// menu so the static create/agent list stays navigable from the search input.
function focusMenuItemAtEdge(fromElement: HTMLElement, edge: 'first' | 'last'): boolean {
  const menu = fromElement.closest('[role="menu"]')
  if (!menu) {
    return false
  }
  const items = menu.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not([data-disabled]):not([aria-disabled="true"])'
  )
  const target = edge === 'first' ? items[0] : items.item(items.length - 1)
  if (!target) {
    return false
  }
  target.focus()
  return true
}
