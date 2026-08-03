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
import type { TuiAgent } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { useAppStore } from '@/store'

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
  onSelectMenuOption,
  worktreeId
}: TabBarCreateEntryProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedIndexQuery, setSelectedIndexQuery] = useState(query)
  const [lastMenuOpen, setLastMenuOpen] = useState(menuOpen)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileList = useRuntimeFileListForWorktree({ enabled: menuOpen, worktreeId })
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
    const entryOptions = getTabEntryOptions(query, fileList, 4, {
      allowAbsolutePaths,
      localPlatform
    })
    if (matchingMenuOptions.length === 0) {
      return entryOptions
    }
    // Why: a matched create-menu action should win over a generic new-file fallback.
    return entryOptions.filter((option) => option.classification.kind !== 'new-file')
  }, [allowAbsolutePaths, fileList, localPlatform, matchingMenuOptions.length, query])
  const matchingAgentOptions = useMemo(
    () => findMatchingTabAgentLaunchOptions(query, agentOptions),
    [agentOptions, query]
  )

  if (selectedIndexQuery !== query) {
    setSelectedIndexQuery(query)
    if (selectedIndex !== 0) {
      // Why: the first filtered action should be highlighted on the same paint as the new query.
      setSelectedIndex(0)
    }
  }

  if (lastMenuOpen !== menuOpen) {
    setLastMenuOpen(menuOpen)
    if (!menuOpen) {
      setQuery('')
      setPending(false)
      setError(null)
      setSelectedIndex(0)
    }
  }

  const disabled = !onOpenEntry
  const hasQuery = query.trim().length > 0
  const activeOptions: ActiveOption[] = [
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
  const activeSelectedIndex = Math.min(selectedIndex, Math.max(activeOptions.length - 1, 0))
  const selectedActiveOption = activeOptions[activeSelectedIndex]
  const statusOption = options.find(
    (option) => option.classification.kind === 'empty' || option.classification.kind === 'blocked'
  )
  const statusMessage =
    statusOption?.classification.kind === 'empty' || statusOption?.classification.kind === 'blocked'
      ? statusOption.classification.message
      : 'Open any file, URL, agent, ...'

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
            setSelectedIndex((current) => {
              const delta = event.key === 'ArrowDown' ? 1 : -1
              return (current + delta + activeOptions.length) % activeOptions.length
            })
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
          }}
          disabled={disabled}
          role="combobox"
          aria-expanded={activeOptions.length > 0}
          aria-controls={RESULT_LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={
            activeOptions.length > 0 && !error ? resultOptionDomId(activeSelectedIndex) : undefined
          }
          aria-label={translate(
            'auto.components.tab.bar.TabBarCreateEntry.39676a184c',
            'Open any file, URL, agent, ...'
          )}
          aria-invalid={error ? true : undefined}
          placeholder={translate(
            'auto.components.tab.bar.TabBarCreateEntry.39676a184c',
            'Open any file, URL, agent, ...'
          )}
          className="h-9 rounded-none border-0 bg-transparent px-0 text-xs font-normal text-foreground shadow-none placeholder:font-normal placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 aria-invalid:border-0 aria-invalid:ring-0 md:text-xs dark:bg-transparent"
        />
      </div>
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
