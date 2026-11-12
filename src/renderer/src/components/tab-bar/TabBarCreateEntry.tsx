import React, { useEffect, useMemo, useRef, useState } from 'react'
import { TabEntrySearchField } from './TabEntrySearchField'
import { createTabAgentSearchHintSession } from './tab-agent-search-hint-session'
import { useRuntimeFileListForWorktree } from '../quick-open-file-list'
import {
  createTabEntryAllowAbsolutePathsSelector,
  getTabEntryOptions,
  isTabEntryAbsolutePathLike
} from './tab-create-entry-action'
import {
  agentResultSetupOption,
  matchingAgentLaunchOptions,
  tabAgentLaunchOptionDisabled
} from './tab-agent-launch-options'
import { findMatchingTabCreateMenuOptions } from './tab-create-menu-options'
import { getActiveOptionId, type ActiveOption } from './tab-create-entry-active-option'
import {
  EntryActionRow,
  useEntrySetupSubmenu,
  EntryStatusRow,
  RESULT_LISTBOX_ID,
  resultOptionDomId
} from './TabBarCreateEntryRow'
import { dropFileEntriesCoveredByTabResults } from './open-tab-entry-dedupe'
import { placeHistoryRowsInEntryOptions } from './tab-create-entry-history-placement'
import { useOmniboxBrowserHistory } from './use-omnibox-browser-history'
import { useTabEntryMenuReturnFocus } from './use-tab-entry-menu-return-focus'
import { activateOpenTabSearchResult } from './open-tab-selection-routing'
import { useTabCreateEntrySearchResults } from './use-tab-create-entry-search-results'
import { DEFAULT_SEARCH_ENGINE } from '../../../../shared/browser-url'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { useAppStore } from '@/store/index'
import { useFileListWorktree } from '@/store/workspaces/selection/use-selected-worktree'
import { isQuickOpenQueryTooLarge } from '../../../../shared/quick-open/quick-open-path-search'
import { parseForcedSearchQuery } from './tab-create-entry-forced-search'
import { useNetworkSafeTabEntrySelection } from './tab-create-entry-network-selection'
import { focusTabEntryMenuItemAtEdge } from './tab-create-entry-keyboard-focus'
import {
  getTabEntryChooseActionMessage,
  getTabEntryOmniboxPlaceholder
} from './tab-create-entry-copy'
import { EMPTY_AGENT_OPTIONS, EMPTY_MENU_OPTIONS } from './tab-create-entry-empty-options'
import type { TabEntryActionClassification } from './tab-create-entry-classifier'
import type { TabBarCreateEntryProps } from './tab-create-entry-props'
import { useTranslate } from '@/i18n/use-translate'

export default function TabBarCreateEntry(props: TabBarCreateEntryProps): React.JSX.Element {
  return <TabBarCreateEntrySession key={String(props.menuOpen)} {...props} />
}

function TabBarCreateEntrySession({
  agentOptions = EMPTY_AGENT_OPTIONS,
  agentPickerEntries,
  groupId,
  menuOpen,
  menuOptions = EMPTY_MENU_OPTIONS,
  onDidOpenEntry,
  onLaunchAgent,
  onLaunchAgentOption,
  onOpenDefaultTerminal,
  onOpenEntry,
  onQueryChange,
  onQueueSwitchFocus,
  onSelectMenuOption,
  terminalPending,
  worktreeId
}: TabBarCreateEntryProps): React.JSX.Element {
  const t = useTranslate()
  const [hintSession] = useState(createTabAgentSearchHintSession)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [selectionGuidance, setSelectionGuidance] = useState<string | null>(null)
  // null = follow ranking (deferred tabs can prepend); set on arrow keys only.
  const [pinnedOptionId, setPinnedOptionId] = useState<string | null>(null)
  const setupSubmenu = useEntrySetupSubmenu()
  const inputRef = useRef<HTMLInputElement>(null)
  const submissionIdRef = useRef(0)
  const updateQuery = (nextQuery: string) => {
    setQuery(nextQuery)
    onQueryChange?.(nextQuery)
    setPinnedOptionId(null)
    setError(null)
    setSwitchError(null)
    setSelectionGuidance(null)
  }
  useEffect(() => {
    return () => {
      submissionIdRef.current += 1
    }
  }, [])
  const fileList = useRuntimeFileListForWorktree({ enabled: menuOpen, worktreeId })
  const rawQueryOversized = isQuickOpenQueryTooLarge(query)
  const forcedSearch = parseForcedSearchQuery(query)
  const terminalQueryMode = rawQueryOversized || forcedSearch.forced
  const tabResults = useTabCreateEntrySearchResults({
    enabled: menuOpen && !terminalQueryMode,
    query,
    worktreeId,
    retainedResultId: pinnedOptionId
  })
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
  // Deduplicate using the workspace filesystem; the client platform cannot establish path case sensitivity.
  const worktreePath = useFileListWorktree(menuOpen ? worktreeId : null)?.path ?? null
  const localPlatform = getRendererAppPlatform() === 'win32' ? 'windows' : 'posix'
  const searchEngine = useAppStore(
    (state) => state.browserDefaultSearchEngine ?? DEFAULT_SEARCH_ENGINE
  )

  useTabEntryMenuReturnFocus(inputRef, menuOpen)

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
  const historyRows = useOmniboxBrowserHistory({
    enabled: menuOpen && !terminalQueryMode,
    query,
    tabResults
  })
  const matchingAgentOptions = useMemo(
    () =>
      terminalQueryMode
        ? EMPTY_AGENT_OPTIONS
        : matchingAgentLaunchOptions(agentPickerEntries, agentOptions, query, terminalPending),
    [agentOptions, agentPickerEntries, query, terminalPending, terminalQueryMode]
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
    ...placeHistoryRowsInEntryOptions(options, historyRows)
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
      : getTabEntryOmniboxPlaceholder(t)

  const submitOption = (option?: ActiveOption) => {
    if (disabled || pending) {
      return false
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
      // Empty status is guidance rather than failure; do not turn a bare query marker into an error.
      if (statusOption?.classification.kind !== 'empty') {
        setError(statusMessage)
      }
      return
    }
    if (selectedOption.kind === 'tab') {
      const outcome = activateOpenTabSearchResult(selectedOption.option)
      if (outcome.status === 'blocked') {
        return
      }
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
      if (tabAgentLaunchOptionDisabled(selectedOption.option)) {
        return false
      }
      hintSession.trackAction('agent_selected')
      const accepted = onLaunchAgentOption
        ? onLaunchAgentOption(selectedOption.option)
        : onLaunchAgent?.(selectedOption.option.agent)
      if (accepted !== false) {
        onDidOpenEntry?.()
      }
      return accepted
    }
    // Route history through typed-URL navigation to preserve workspace targeting and SSH resolution.
    const classification: TabEntryActionClassification =
      selectedOption.kind === 'history'
        ? { kind: 'explicit-url', url: selectedOption.option.entry.url }
        : selectedOption.option.classification
    setPending(true)
    setError(null)
    const submissionId = ++submissionIdRef.current
    void onOpenEntry({ query, worktreeId, groupId, fileList, classification })
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
          // With no search results, transfer arrow navigation to static Radix items so the input cannot trap focus.
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
      <TabEntrySearchField
        agentPickerEntries={agentPickerEntries}
        hintSession={hintSession}
        eligibleForHint={menuOpen && !disabled}
        inputRef={inputRef}
        value={query}
        onQueryChange={updateQuery}
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
        aria-invalid={error ? true : undefined}
        aria-errormessage={error ? 'tab-create-entry-error' : undefined}
      />
      {/* Keep a mounted live region above usable rows so stale-target failures announce without removing other choices. */}
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
                setupOpen={setupSubmenu.openId === getActiveOptionId(option)}
                onSetupOpenChange={(open) => setupSubmenu.change(getActiveOptionId(option), open)}
                onHover={() => setupSubmenu.hover(getActiveOptionId(option))}
                onUseAgent={
                  option.kind === 'agent' && option.option.pickerEntry
                    ? (draft) =>
                        submitOption(agentResultSetupOption(option, draft, terminalPending))
                    : undefined
                }
                terminalPending={terminalPending}
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
