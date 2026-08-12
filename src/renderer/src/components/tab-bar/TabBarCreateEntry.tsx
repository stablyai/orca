import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { useRuntimeFileListForWorktree } from '../quick-open-file-list'
import {
  createTabEntryAllowAbsolutePathsSelector,
  getTabEntryOptions,
  isTabEntryAbsolutePathLike
} from './tab-create-entry-action'
import { findMatchingTabAgentLaunchOptions } from './tab-agent-launch-options'
import { findMatchingTabCreateMenuOptions } from './tab-create-menu-options'
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
import { DEFAULT_SEARCH_ENGINE } from '../../../../shared/browser-url'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { useAppStore } from '@/store'
import { isQuickOpenQueryTooLarge } from '../quick-open-search'
import { parseForcedSearchQuery } from './tab-create-entry-forced-search'
import { useNetworkSafeTabEntrySelection } from './tab-create-entry-network-selection'
import { focusTabEntryMenuItemAtEdge } from './tab-create-entry-keyboard-focus'
import {
  getTabEntryChooseActionMessage,
  getTabEntryOmniboxPlaceholder
} from './tab-create-entry-copy'
import {
  EMPTY_AGENT_OPTIONS,
  EMPTY_MENU_OPTIONS,
  EMPTY_TAB_RESULTS
} from './tab-create-entry-empty-options'
import type { TabBarCreateEntryProps } from './tab-create-entry-props'

export default function TabBarCreateEntry(props: TabBarCreateEntryProps): React.JSX.Element {
  return <TabBarCreateEntrySession key={String(props.menuOpen)} {...props} />
}

function TabBarCreateEntrySession({
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
  const [selectionGuidance, setSelectionGuidance] = useState<string | null>(null)
  // null = follow ranking (deferred tabs can prepend); set on arrow keys only.
  const [pinnedOptionId, setPinnedOptionId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const submissionIdRef = useRef(0)
  useEffect(
    () => () => {
      submissionIdRef.current += 1
    },
    []
  )
  const fileList = useRuntimeFileListForWorktree({ enabled: menuOpen, worktreeId })
  const rawQueryOversized = isQuickOpenQueryTooLarge(query)
  const forcedSearch = parseForcedSearchQuery(query)
  const terminalQueryMode = rawQueryOversized || forcedSearch.forced
  const tabSearchQuery = terminalQueryMode ? '' : query
  const tabSearch = useOpenTabSearch({
    enabled: menuOpen && !terminalQueryMode,
    query: tabSearchQuery,
    worktreeId
  })
  // Why gate on the query: the search defers, so its rows can still describe an
  // earlier query — Enter must never submit a tab the current query never matched.
  const tabResults =
    !terminalQueryMode && tabSearch.query === query ? tabSearch.results : EMPTY_TAB_RESULTS
  const shouldResolveAbsolutePaths =
    menuOpen && !terminalQueryMode && isTabEntryAbsolutePathLike(query.trim())
  const allowAbsolutePathsSelector = useMemo(
    () =>
      createTabEntryAllowAbsolutePathsSelector(worktreeId, {
        skip: !shouldResolveAbsolutePaths
      }),
    [shouldResolveAbsolutePaths, worktreeId]
  )
  const allowAbsolutePaths = useAppStore(allowAbsolutePathsSelector)
  // Why the worktree path: editor↔file dedupe folds case by the worktree's
  // filesystem, which a Windows client's own platform does not describe.
  const worktreePath = useAppStore((state) =>
    menuOpen ? (state.getKnownWorktreeById(worktreeId)?.path ?? null) : null
  )
  const localPlatform = getRendererAppPlatform() === 'win32' ? 'windows' : 'posix'
  const searchEngine = useAppStore(
    (state) => state.browserDefaultSearchEngine ?? DEFAULT_SEARCH_ENGINE
  )

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
    () =>
      terminalQueryMode ? EMPTY_MENU_OPTIONS : findMatchingTabCreateMenuOptions(query, menuOptions),
    [menuOptions, query, terminalQueryMode]
  )
  const options = useMemo(() => {
    const entryOptions = dropFileEntriesCoveredByTabResults(
      getTabEntryOptions(query, fileList, 4, {
        allowAbsolutePaths,
        localPlatform,
        searchEngine
      }),
      tabResults,
      worktreePath
    )
    if (matchingMenuOptions.length === 0) {
      return entryOptions
    }
    // Why: a matched create-menu action should win over a generic new-file fallback.
    return entryOptions.filter((option) => option.classification.kind !== 'new-file')
  }, [
    allowAbsolutePaths,
    fileList,
    localPlatform,
    matchingMenuOptions.length,
    query,
    searchEngine,
    tabResults,
    worktreePath
  ])
  const matchingAgentOptions = useMemo(
    () =>
      terminalQueryMode
        ? EMPTY_AGENT_OPTIONS
        : findMatchingTabAgentLaunchOptions(query, agentOptions),
    [agentOptions, query, terminalQueryMode]
  )

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
  const { activeSelectedIndex, selectedActiveOption } = useNetworkSafeTabEntrySelection({
    activeOptions,
    fileIndexFailed: Boolean(fileList.loadError),
    fileIndexReady: !fileList.loading && !fileList.loadError,
    forcedSearch: forcedSearch.forced,
    menuOpen,
    pinnedOptionId,
    query
  })
  const statusOption = options.find(
    (option) => option.classification.kind === 'empty' || option.classification.kind === 'blocked'
  )
  const statusMessage =
    statusOption != null &&
    (statusOption.classification.kind === 'empty' || statusOption.classification.kind === 'blocked')
      ? statusOption.classification.message
      : getTabEntryOmniboxPlaceholder()

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
      if (activeOptions.length > 0) {
        setSelectionGuidance(getTabEntryChooseActionMessage())
        return
      }
      // Why: an 'empty' status is the placeholder prompt, not a failure — showing
      // it as an error turns a bare "?" into a red row that reads like a bug.
      if (statusOption?.classification.kind !== 'empty') {
        setError(statusMessage)
      }
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
    const submissionId = ++submissionIdRef.current
    void onOpenEntry({
      query,
      worktreeId,
      groupId,
      fileList,
      classification: selectedOption.option.classification
    })
      .then(() => {
        if (submissionIdRef.current === submissionId) {
          onDidOpenEntry?.()
        }
      })
      .catch((caught) => {
        if (submissionIdRef.current === submissionId) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })
      .finally(() => {
        if (submissionIdRef.current === submissionId) {
          setPending(false)
        }
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
              activeSelectedIndex === null
                ? event.key === 'ArrowDown'
                  ? 0
                  : activeOptions.length - 1
                : (activeSelectedIndex + delta + activeOptions.length) % activeOptions.length
            setPinnedOptionId(getActiveOptionId(activeOptions[nextIndex]))
            setSelectionGuidance(null)
            return
          }
          // Why: with no result rows the static create/agent items render below;
          // move focus into that Radix menu list so it stays keyboard-navigable
          // from the search box instead of trapping focus in the input.
          if (
            focusTabEntryMenuItemAtEdge(
              event.currentTarget,
              event.key === 'ArrowDown' ? 'first' : 'last'
            )
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
            setPinnedOptionId(null)
            setError(null)
            setSwitchError(null)
            setSelectionGuidance(null)
          }}
          // Why: disabling the focused input would hand focus to the body and
          // break arrow/Escape navigation until the submission settles.
          disabled={disabled}
          readOnly={pending}
          aria-busy={pending || undefined}
          role="combobox"
          aria-expanded={!error && activeOptions.length > 0}
          aria-controls={!error && activeOptions.length > 0 ? RESULT_LISTBOX_ID : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            activeSelectedIndex !== null && !error
              ? resultOptionDomId(activeSelectedIndex)
              : undefined
          }
          aria-label={getTabEntryOmniboxPlaceholder()}
          aria-invalid={error ? true : undefined}
          aria-errormessage={error ? 'tab-create-entry-error' : undefined}
          placeholder={getTabEntryOmniboxPlaceholder()}
          className="h-9 rounded-none border-0 bg-transparent px-0 text-xs font-normal text-foreground shadow-none placeholder:font-normal placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 aria-invalid:border-0 aria-invalid:ring-0 md:text-xs dark:bg-transparent"
        />
      </div>
      {/* Above the list, not instead of it: a stale switch target must not wipe
          the rows the user can still act on. The live region stays mounted so a
          screen reader announces the failure instead of missing the insertion. */}
      <div role="status">
        {error ? (
          <div className="mt-1 px-1" id="tab-create-entry-error">
            <EntryStatusRow message={error} />
          </div>
        ) : null}
        {switchError ? (
          <div className="mt-1 px-1">
            <EntryStatusRow message={switchError} />
          </div>
        ) : null}
        {selectionGuidance ? (
          <div className="mt-1 px-1">
            <EntryStatusRow message={selectionGuidance} />
          </div>
        ) : null}
        {activeOptions.length > 0 && statusOption ? (
          <div className="mt-1 px-1">
            <EntryStatusRow loading={fileList.loading} message={statusMessage} />
          </div>
        ) : null}
      </div>
      {!error && (activeOptions.length > 0 || hasQuery) ? (
        <div
          className="mt-1 space-y-0.5 px-1"
          id={RESULT_LISTBOX_ID}
          role={activeOptions.length > 0 ? 'listbox' : undefined}
        >
          {activeOptions.length > 0 ? (
            activeOptions.map((option, index) => (
              <EntryActionRow
                key={getActiveOptionId(option)}
                id={resultOptionDomId(index)}
                option={option}
                selected={index === activeSelectedIndex}
                disabled={disabled || pending}
                loading={pending && index === activeSelectedIndex}
                onClick={() => {
                  setSelectionGuidance(null)
                  submitOption(option)
                }}
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
