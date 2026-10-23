import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { DEFAULT_SEARCH_ENGINE, type SearchEngine } from '../../../../../shared/browser-url'
import type { BrowserPageDocLocation } from '../../../../../shared/browser-workspace-types'
import { buildBrowserAddressBarSuggestions } from './browser-address-bar-suggestions'
import { useBrowserAddressBarInlineCompletion } from './use-browser-address-bar-inline-completion'
import { useBrowserAddressBarSwitchToTab } from './use-browser-address-bar-switch-to-tab'
import { useBrowserAddressBarEditHandoff } from './use-browser-address-bar-edit-handoff'
import { useBrowserAddressBarOverlay } from './browser-address-bar-expansion'
import { useBrowserAddressBarClickSelect } from './use-browser-address-bar-click-select'
import { useBrowserAddressBarDismissal } from './use-browser-address-bar-dismissal'
import type { BrowserAddressBarEditSessionBinding } from './use-browser-address-bar-edit-session'
import BrowserAddressBarSuggestionList from './BrowserAddressBarSuggestionList'
import { BrowserLoadProgress } from './browser-load-progress'

function clearTimerRef(timerRef: { current: number | null }): void {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }
}

type BrowserAddressBarProps = {
  /** The page this bar edits; its worktree's other open pages are offered as "Switch to tab". */
  pageId: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onNavigate: (url: string) => void
  /** Selecting a previewed-document suggestion; without it those rows fall back to onNavigate. */
  onOpenWorkspaceDoc?: (docLocation: BrowserPageDocLocation) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  dismissSuggestionsRef?: React.MutableRefObject<(() => void) | null>
  /**
   * Set by panes React can swap out from under a live edit, so an unmount mid-typing is handed on
   * to whatever mounts next for the same page. Panes that never remount leave it off.
   */
  editSession?: BrowserAddressBarEditSessionBinding | null
  /** Replaces the leading globe (e.g. the SSH egress indicator). */
  leadingIcon?: React.ReactNode
  loading?: boolean
  loadFailed?: boolean
}

export default function BrowserAddressBar({
  pageId,
  value,
  onChange,
  onSubmit,
  onNavigate,
  onOpenWorkspaceDoc,
  inputRef,
  dismissSuggestionsRef,
  editSession,
  leadingIcon,
  loading = false,
  loadFailed = false
}: BrowserAddressBarProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [selectedValueOverride, setSelectedValueOverride] = useState<string | null>(null)
  const prePreviewValueRef = useRef<string | null>(null)
  // Why: while previewing a highlighted suggestion the input shows the full URL,
  // but suggestions must keep matching the original typed query.
  const autocompleteQuery = prePreviewValueRef.current ?? value
  const browserUrlHistory = useAppStore((s) => s.browserUrlHistory)
  const workspaceDocHistory = useAppStore((s) => s.workspaceDocHistory)
  const browserDefaultSearchEngine = useAppStore((s) => s.browserDefaultSearchEngine)
  const browserKagiSessionLink = useAppStore((s) => s.browserKagiSessionLink)
  const closingRef = useRef(false)
  const addressBarClickSelect = useBrowserAddressBarClickSelect()
  const openedAtRef = useRef(0)
  const blurCloseTimerRef = useRef<number | null>(null)
  const closingResetTimerRef = useRef<number | null>(null)
  const slotRef = useRef<HTMLDivElement | null>(null)
  const overlay = useBrowserAddressBarOverlay(slotRef, open)

  const clearAddressBarTimers = useCallback((): void => {
    clearTimerRef(blurCloseTimerRef)
    clearTimerRef(closingResetTimerRef)
  }, [])

  const setAddressBarFormRef = useCallback(
    (node: HTMLFormElement | null) => {
      if (node === null) {
        clearAddressBarTimers()
      }
    },
    [clearAddressBarTimers]
  )

  const searchEngine: SearchEngine =
    (browserDefaultSearchEngine as SearchEngine | null) ?? DEFAULT_SEARCH_ENGINE

  const buildSuggestions = useCallback(
    (query: string, inline: true | string | null) =>
      buildBrowserAddressBarSuggestions({
        browserUrlHistory,
        workspaceDocHistory,
        kagiSessionLink: browserKagiSessionLink,
        searchEngine,
        value: query,
        inline
      }),
    [browserUrlHistory, workspaceDocHistory, searchEngine, browserKagiSessionLink]
  )
  const { inlineText, completeTyping, clearInline, showInline, acceptOnCaretMove } =
    useBrowserAddressBarInlineCompletion({ inputRef, value, buildSuggestions, prePreviewValueRef })
  useBrowserAddressBarEditHandoff({
    editSession,
    inputRef,
    prePreviewValueRef,
    openedAtRef,
    setSelectedValueOverride,
    setOpen,
    live: { value, open, inlineShown: inlineText !== null && value === inlineText }
  })
  const suggestions = useMemo(
    () => buildSuggestions(autocompleteQuery, inlineText),
    [buildSuggestions, autocompleteQuery, inlineText]
  )

  const clearSuggestionPreview = useCallback((): void => {
    prePreviewValueRef.current = null
    setSelectedValueOverride(null)
    clearInline()
  }, [clearInline])

  const previewSuggestion = useCallback(
    (url: string): void => {
      if (prePreviewValueRef.current === null) {
        prePreviewValueRef.current = autocompleteQuery
      }
      setSelectedValueOverride(url)
      onChange(url)
    },
    [autocompleteQuery, onChange]
  )

  const selectSuggestionAtIndex = useCallback(
    (index: number): void => {
      const suggestion = suggestions[index]
      if (!suggestion) {
        return
      }
      if (suggestion.isSearch) {
        // Why: the search row is what Enter does with the typed query, so the bar keeps the
        // typed text instead of the search URL.
        prePreviewValueRef.current = null
        clearInline()
        setSelectedValueOverride(suggestion.url)
        onChange(autocompleteQuery)
        return
      }
      if (suggestion.inlineText !== undefined) {
        // Why: like Chrome, the completion comes back as typed text plus a selected tail, so
        // Escape still restores what was typed.
        setSelectedValueOverride(suggestion.url)
        showInline(autocompleteQuery, suggestion.inlineText)
        onChange(suggestion.inlineText)
        return
      }
      previewSuggestion(suggestion.url)
    },
    [autocompleteQuery, clearInline, onChange, previewSuggestion, showInline, suggestions]
  )

  const restoreTypedQuery = useCallback((): void => {
    const typed = prePreviewValueRef.current
    if (typed === null) {
      return
    }
    prePreviewValueRef.current = null
    setSelectedValueOverride(null)
    clearInline()
    onChange(typed)
  }, [clearInline, onChange])

  const dismissSuggestions = useCallback((): void => {
    clearTimerRef(blurCloseTimerRef)
    restoreTypedQuery()
    setOpen(false)
  }, [restoreTypedQuery])

  const switchToTab = useBrowserAddressBarSwitchToTab({
    pageId,
    open,
    dismissSuggestions,
    onChange,
    onNavigate
  })

  // Why nothing for an empty bar: row 0 always shows what Enter does, and there Enter does nothing.
  const selectedValue =
    selectedValueOverride &&
    suggestions.some((suggestion) => suggestion.url === selectedValueOverride)
      ? selectedValueOverride
      : autocompleteQuery.trim() === ''
        ? ''
        : (suggestions[0]?.url ?? '')
  const selectedRow = suggestions.find((suggestion) => suggestion.url === selectedValue)
  const switchFocused = switchToTab.focusedUrl === selectedValue

  const handleFocus = useCallback(() => {
    if (closingRef.current) {
      return
    }
    clearTimerRef(blurCloseTimerRef)
    inputRef.current?.select()
    openedAtRef.current = Date.now()
    // Why: an empty bar is a blank tab, whose New Tab page already lists what the dropdown would.
    if (value !== '') {
      setOpen(true)
    }
  }, [inputRef, value])

  const handleBlur = useCallback(() => {
    // Why: delay close so that clicking a suggestion item registers before
    // the popover unmounts. Without this, onSelect never fires because the
    // mousedown on PopoverContent triggers input blur first.
    //
    // Why (grace window): BrowserPane's focusAddressBarNow() retries focus
    // across multiple animation frames to fight webview focus stealing. Each
    // cycle can cause a transient blur on the input. Without this guard the
    // popover opens on focus, immediately gets a blur, and closes ~150ms later
    // — producing the "flash then disappear" on first click.
    const elapsed = Date.now() - openedAtRef.current
    const grace = elapsed < 400
    clearTimerRef(blurCloseTimerRef)
    blurCloseTimerRef.current = window.setTimeout(() => {
      blurCloseTimerRef.current = null
      if (grace && inputRef.current && document.activeElement === inputRef.current) {
        return
      }
      restoreTypedQuery()
      setOpen(false)
    }, 200)
  }, [inputRef, restoreTypedQuery])

  const handleSelect = useCallback(
    (url: string) => {
      closingRef.current = true
      setOpen(false)
      clearSuggestionPreview()
      // Why looked up by row: a workspace-doc suggestion opens on a fresh grant instead of
      // navigating; its url is the document's path, so even the fallback routes via detection.
      const docLocation = suggestions.find(
        (suggestion) => suggestion.url === url && suggestion.docLocation
      )?.docLocation
      if (docLocation && onOpenWorkspaceDoc) {
        onOpenWorkspaceDoc(docLocation)
      } else {
        onNavigate(url)
      }
      clearTimerRef(closingResetTimerRef)
      closingResetTimerRef.current = window.setTimeout(() => {
        closingResetTimerRef.current = null
        closingRef.current = false
      }, 100)
    },
    [clearSuggestionPreview, onNavigate, onOpenWorkspaceDoc, suggestions]
  )

  const submitTypedValue = useCallback((): void => {
    // Why: like Chrome, Enter on an empty bar does nothing rather than blanking the page.
    if (value.trim() === '') {
      return
    }
    setOpen(false)
    clearSuggestionPreview()
    onSubmit()
  }, [clearSuggestionPreview, onSubmit, value])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        dismissSuggestions()
        return
      }

      if (switchToTab.handleTabKey(event, selectedRow)) {
        return
      }

      if (event.key === 'Enter' && open) {
        event.preventDefault()
        if (switchFocused) {
          switchToTab.switchToTab(selectedValue)
          return
        }
        // Why: match Chrome — otherwise Enter navigates to the current input text,
        // not the highlighted dropdown row (click still picks a row directly).
        submitTypedValue()
        return
      }

      if (!open || suggestions.length === 0) {
        return
      }

      const isPreviewing = prePreviewValueRef.current !== null

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const idx = suggestions.findIndex((s) => s.url === selectedValue)
        // Why: row 0 stays highlighted while the input still shows the typed
        // query, so the first ArrowDown should advance to the next row instead
        // of redundantly previewing the row Enter already covers.
        const next = idx !== -1 && idx < suggestions.length - 1 ? idx + 1 : 0
        selectSuggestionAtIndex(next)
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const idx = suggestions.findIndex((s) => s.url === selectedValue)
        const startIdx = Math.max(idx, 0)
        if (!isPreviewing) {
          const next = startIdx > 0 ? startIdx - 1 : suggestions.length - 1
          selectSuggestionAtIndex(next)
          return
        }
        if (startIdx <= 0) {
          restoreTypedQuery()
          return
        }
        selectSuggestionAtIndex(startIdx - 1)
      }
    },
    [
      open,
      suggestions,
      selectedValue,
      switchToTab,
      selectedRow,
      switchFocused,
      selectSuggestionAtIndex,
      restoreTypedQuery,
      dismissSuggestions,
      submitTypedValue
    ]
  )

  useBrowserAddressBarDismissal(open, dismissSuggestions)

  useEffect(() => {
    if (!dismissSuggestionsRef) {
      return
    }
    dismissSuggestionsRef.current = dismissSuggestions
    return () => {
      dismissSuggestionsRef.current = null
    }
  }, [dismissSuggestions, dismissSuggestionsRef])

  return (
    // Why: min-w-11 keeps the leading globe a real hit target once the toolbar
    // squeezes the bar away — without it neighbouring buttons overlap the only
    // affordance for reopening the URL field.
    // Why stretch: the toolbar row pins the address slot's height, and the bar must fill it rather
    // than size itself — otherwise it and the document chip drift apart again.
    <div ref={slotRef} className="flex min-w-11 flex-1 items-stretch">
      <Popover
        modal={false}
        open={open}
        onOpenChange={(next) => {
          // Why: Radix fires onOpenChange(false) when it detects an outside
          // interaction, but during the focus-retry loop the input may still
          // hold focus. Only allow programmatic closes (setOpen(false) from
          // our handlers) or genuine outside dismissals.
          if (!next && inputRef.current && document.activeElement === inputRef.current) {
            return
          }
          if (!next) {
            restoreTypedQuery()
          }
          setOpen(next)
        }}
      >
        <PopoverTrigger asChild>
          <form
            ref={setAddressBarFormRef}
            data-orca-browser-address-bar-overlay={overlay ? 'true' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-1 shadow-sm',
              // Why: the toolbar row is the positioned ancestor, so the overlay
              // spans it edge to edge (matching its px-3) instead of the few
              // pixels the squeezed slot has left.
              overlay
                ? 'absolute inset-x-3 top-1/2 z-30 -translate-y-1/2 shadow-[0_10px_24px_rgba(0,0,0,0.18)]'
                : 'relative min-w-0 flex-1'
            )}
            // Why: when squeezed the input is zero-width, so clicks land on the
            // form padding — forward them to the input so it expands and edits.
            onClick={() => inputRef.current?.focus()}
            onSubmit={(event) => {
              event.preventDefault()
              submitTypedValue()
            }}
          >
            {leadingIcon ?? <Globe className="size-4 shrink-0 text-muted-foreground" />}
            <Input
              ref={inputRef}
              value={value}
              placeholder={translate(
                'auto.components.browser.pane.browser.address.bar.placeholder',
                'Search or enter URL'
              )}
              onFocus={handleFocus}
              onMouseDown={addressBarClickSelect.onMouseDown}
              onClick={addressBarClickSelect.onClick}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              onSelect={acceptOnCaretMove}
              data-orca-browser-address-bar="true"
              className="h-auto border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(event) => {
                const nextValue = event.target.value
                // Why: typing creates a new suggestion list, so keyboard selection
                // should return to the derived top match instead of a stale row.
                // Clearing preview state here also prevents stale hover/selection
                // from repopulating the input after Cmd+A → Delete.
                prePreviewValueRef.current = null
                setSelectedValueOverride(null)
                switchToTab.clearFocus()
                // Why: like Chrome, typing after Escape brings the suggestions back.
                setOpen(true)
                const completed = completeTyping(event, nextValue)
                if (completed !== null) {
                  prePreviewValueRef.current = nextValue
                }
                onChange(completed ?? nextValue)
              }}
              role="combobox"
              aria-expanded={open}
              aria-controls="browser-history-listbox"
              aria-autocomplete="list"
            />
            <BrowserLoadProgress loading={loading} failed={loadFailed} />
          </form>
        </PopoverTrigger>
        {suggestions.length > 0 && (
          <PopoverContent
            align="start"
            sideOffset={4}
            className="w-[var(--radix-popover-trigger-width)] p-0"
            onOpenAutoFocus={(e) => {
              // Why: prevent the popover from stealing focus away from the
              // address bar input. The user is still typing; the popover is
              // an overlay of suggestions, not a focus target.
              e.preventDefault()
            }}
          >
            <BrowserAddressBarSuggestionList
              suggestions={suggestions}
              selectedValue={selectedValue}
              onSelectedValueChange={setSelectedValueOverride}
              onSelect={handleSelect}
              hasSwitchTarget={switchToTab.hasSwitchTarget}
              switchFocusedUrl={switchFocused ? selectedValue : null}
              onSwitchToTab={switchToTab.switchToTab}
            />
          </PopoverContent>
        )}
      </Popover>
    </div>
  )
}
