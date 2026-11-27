import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { botRefKey } from '@/lib/bot-hosts'
import { holdSidebarBotsHeightForSearch } from '@/components/sidebar/SidebarBotsSplit'
import type { Bot } from '../../../../shared/bot-types'
import { createBotSidebarSearchIndex } from '../../../../shared/bots/bot-sidebar-search'
import { buildByIdIndex } from '../../../../shared/collections/first-row-by-id-index'
import { getBotPurpose, useBotPurposeReader } from './bot-purpose-cache'
import { refreshBotPurposes, useKnownBotPurposes } from './use-bot-purposes'
import { BotSearchResultRow, type BotSearchEntry } from './BotSearchResultRow'
import { useBotSearchViewport } from './use-bot-search-viewport'
import { setBotSidebarSearchHasQuery } from './reveal-bot-sidebar-row'

// Debounce what a screen reader hears, not the filtering, so typing isn't read out letter by letter.
const ANNOUNCE_DELAY_MS = 400

/** The Bots header's search toggle: it opens the field under the header, and closes it again. */
export function BotSidebarSearchButton({
  open,
  onToggle,
  buttonRef
}: {
  open: boolean
  onToggle: () => void
  buttonRef: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('bots.search.open', 'Search bots')
  return (
    // No tooltip while open, so it never covers the field.
    <Tooltip open={open ? false : undefined}>
      <TooltipTrigger asChild>
        <Button
          ref={buttonRef}
          type="button"
          // Filled while the field is open (aria-expanded), as a pressed toggle.
          variant="muted-field-icon"
          size="icon-xs"
          className="shrink-0"
          aria-label={label}
          aria-expanded={open}
          data-bot-sidebar-search-toggle=""
          onClick={onToggle}
        >
          <Search className="size-3.5" strokeWidth={2.25} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

type SearchPanelProps = {
  /** The entries the list shows, in its order. */
  entries: readonly BotSearchEntry[]
  /** Every entry, filters ignored, to tell about hidden paused bots that match. */
  allEntries: readonly BotSearchEntry[]
  bots: readonly Bot[]
  /** Opens a result; the section's search session closes the search and shows its row. */
  onSelect: (entry: BotSearchEntry) => void
  /** The query changed or focus left the search: a result still opening no longer touches it. */
  onSupersede: () => void
  /** Esc: the section closes the search and puts focus back on its toggle. */
  onCancel: () => void
}

/** Holds the Bots list in one place whether or not search is open, so typing never remounts its rows or chats. */
export function BotSidebarSearchHost({
  open,
  regionRef,
  panel,
  children
}: {
  open: boolean
  regionRef: React.Ref<HTMLDivElement>
  panel: SearchPanelProps
  children: React.ReactNode
}): React.JSX.Element {
  const [hasQuery, setHasQuery] = useState(false)
  const botsById = useMemo(() => buildByIdIndex(panel.bots), [panel.bots])
  const showingResults = open && hasQuery
  // Cmd+K leaves the list alone while it is hidden behind results.
  useEffect(() => {
    setBotSidebarSearchHasQuery(showingResults)
    return () => setBotSidebarSearchHasQuery(false)
  }, [showingResults])
  return (
    <div
      ref={regionRef}
      // With a query it fills the held section, so an empty result can center in it. Not while the
      // list shows: growing around the list as it reappears would clamp the scroll position it kept.
      className={cn('flex min-h-0 flex-col', open && hasQuery && 'grow')}
      onBlur={(event) => {
        // Focus moved to something else: a result still opening leaves the search alone.
        const next = event.relatedTarget
        if (open && (!(next instanceof Node) || !event.currentTarget.contains(next))) {
          panel.onSupersede()
        }
      }}
      onKeyDown={(event) => {
        if (
          !open ||
          event.defaultPrevented ||
          event.key !== 'Escape' ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        ) {
          return
        }
        const target = event.target
        if (!(target instanceof Element) || !event.currentTarget.contains(target)) {
          return
        }
        // Nested editors and portaled menus own their Esc; ordinary rows cancel the search.
        const editor = target.closest(
          'input, textarea, [contenteditable]:not([contenteditable="false"])'
        )
        if (editor && !editor.matches('[data-bot-sidebar-search] input[type="search"]')) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        panel.onCancel()
      }}
    >
      {open ? (
        <BotSidebarSearchPanel {...panel} botsById={botsById} onHasQueryChange={setHasQuery} />
      ) : null}
      {/* Hidden, not unmounted, while results show: rows keep their chats and keep reading purposes. */}
      <div
        className={cn('flex min-h-0 flex-col', open && hasQuery && 'hidden')}
        data-bot-sidebar-list-slot=""
        data-bot-sidebar-list-under-results={open && hasQuery ? '' : undefined}
      >
        {children}
      </div>
    </div>
  )
}

function BotSidebarSearchPanel({
  entries,
  allEntries,
  botsById,
  onSelect,
  onSupersede,
  onHasQueryChange
}: Omit<SearchPanelProps, 'bots'> & {
  botsById: ReadonlyMap<string, Bot>
  onHasQueryChange: (hasQuery: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const requestedPurposes = useRef(false)
  const hidePaused = useAppStore((s) => s.botSidebarView.hidePausedBots)
  const setView = useAppStore((s) => s.setBotSidebarView)
  const readRowPurpose = useBotPurposeReader()
  const hasQuery = query.trim() !== ''
  const rosterPurposes = useKnownBotPurposes()
  const search = useMemo(
    () =>
      createBotSidebarSearchIndex({
        shown: entries,
        all: hidePaused ? allEntries : entries,
        purposeOf: (entry) => getBotPurpose(entry.id)
      }),
    [entries, allEntries, hidePaused]
  )
  const readPurpose = useCallback(
    (entry: BotSearchEntry) =>
      entry.kind === 'bot'
        ? (readRowPurpose(entry.id) ?? rosterPurposes.get(botRefKey(entry.bot)) ?? null)
        : null,
    [readRowPurpose, rosterPurposes]
  )
  const result = useMemo(() => search(query, readPurpose), [search, query, readPurpose])
  // Before the first paint, so the open field never shows at a height typing would then change.
  useLayoutEffect(() => {
    const input = inputRef.current
    return input ? holdSidebarBotsHeightForSearch(input) : undefined
  }, [])
  useBotSearchViewport(inputRef, hasQuery)
  // Before paint: the host hides the list and fills the box in the same frame as the first keystroke,
  // so a no-match line never shows at the top and then moves to the middle.
  useLayoutEffect(() => {
    onHasQueryChange(hasQuery)
  }, [hasQuery, onHasQueryChange])
  useEffect(() => () => onHasQueryChange(false), [onHasQueryChange])

  const changeQuery = (value: string): void => {
    if (value.trim() && !requestedPurposes.current) {
      requestedPurposes.current = true
      void refreshBotPurposes()
    }
    setQuery(value)
    onSupersede()
  }
  const clear = (): void => {
    changeQuery('')
    inputRef.current?.focus()
  }
  const label = t('bots.search.label', 'Search bots')
  const first = result.matches[0]
  // Nothing to list: the no-match line fills the held box under the field, centered in it.
  const empty = hasQuery && result.matches.length === 0

  return (
    <div
      // The split holds the section's height: a field-only panel must not shrink, or the field spills onto the list.
      // With results it is the only thing shown and shrinks so they scroll under the field; fewer leave the rest empty.
      // Only an empty result grows to fill: a growing panel as the list comes back would clamp its kept scroll.
      className={cn('flex flex-col', hasQuery ? 'min-h-0' : 'shrink-0', empty && 'grow')}
      data-bot-sidebar-search={entries.length <= 1 ? 'single-row' : 'multiple-rows'}
    >
      {/* Insets match the list's and a row's, so the field's glyph sits over the bots' pictures.
          The gap below separates the field from the first row. */}
      <div className="relative shrink-0 px-2 pt-1 pb-1.5">
        <Search className="pointer-events-none absolute top-1/2 left-[22px] size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          autoFocus
          type="search"
          value={query}
          aria-label={label}
          placeholder={label}
          density="compact"
          inset="leadingIcon"
          adornment={hasQuery ? 'trailing' : 'none'}
          className="[&::-webkit-search-cancel-button]:hidden"
          onChange={(event) => changeQuery(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'ArrowDown' &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              const firstResult = event.currentTarget
                .closest('[data-bot-sidebar-search]')
                ?.querySelector<HTMLButtonElement>('[data-bot-search-result]')
              if (firstResult) {
                event.preventDefault()
                firstResult.focus()
              }
              return
            }
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) {
              return
            }
            event.preventDefault()
            if (first) {
              onSelect(first.entry)
            }
          }}
        />
        {hasQuery ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute top-1/2 right-2.5 size-6 -translate-y-1/2"
            aria-label={t('bots.search.clear', 'Clear search')}
            // Keeps focus in the field: clearing unmounts this button.
            onMouseDown={(event) => event.preventDefault()}
            onClick={clear}
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </div>
      {hasQuery ? (
        <div
          className={cn(
            'bot-sidebar-scrollbar flex min-h-0 flex-col overflow-y-auto overscroll-y-contain pb-1 px-1',
            // Results start at the top as a list; a no-match line sits in the middle of the held box.
            empty && 'grow justify-center-safe'
          )}
        >
          {result.matches.map((match) => (
            <BotSearchResultRow
              key={match.entry.id}
              match={match}
              // A name match still shows what the bot is for, as its row does.
              purposeLine={match.purpose ? null : readPurpose(match.entry)}
              botsById={botsById}
              onSelect={onSelect}
            />
          ))}
          {/* The message wraps rather than truncates, so a long translation at the narrowest sidebar
              still says why the list is empty; each "· action" pair wraps as one. */}
          {result.matches.length === 0 && result.hiddenPausedMatches === 0 ? (
            <div className="flex flex-wrap items-center gap-x-1 px-3 py-1 text-xs text-muted-foreground">
              <span className="min-w-0 break-words">
                {t('bots.search.noMatches', 'No matches')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span aria-hidden="true">·</span>
                <Button type="button" variant="link" size="inlineText" onClick={clear}>
                  {t('bots.search.clear', 'Clear search')}
                </Button>
              </span>
            </div>
          ) : null}
          {result.hiddenPausedMatches > 0 ? (
            <div className="flex flex-wrap items-center gap-x-1 px-3 py-1 text-xs text-muted-foreground">
              <span className="min-w-0 break-words">
                {t('bots.search.pausedMatches', '{{count}} paused matches', {
                  count: result.hiddenPausedMatches,
                  defaultValue_one: '{{count}} paused match'
                })}
              </span>
              <span className="inline-flex items-center gap-1">
                <span aria-hidden="true">·</span>
                <Button
                  type="button"
                  variant="link"
                  size="inlineText"
                  aria-label={t('bots.search.showPaused', 'Show paused bots')}
                  onClick={() => setView({ hidePausedBots: false })}
                >
                  {t('bots.search.show', 'Show')}
                </Button>
              </span>
              {result.matches.length === 0 ? (
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden="true">·</span>
                  <Button type="button" variant="link" size="inlineText" onClick={clear}>
                    {t('bots.search.clear', 'Clear search')}
                  </Button>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <BotSearchAnnouncement
        active={hasQuery}
        count={result.matches.length}
        pausedCount={result.hiddenPausedMatches}
      />
    </div>
  )
}

function BotSearchAnnouncement({
  active,
  count,
  pausedCount
}: {
  active: boolean
  count: number
  pausedCount: number
}): React.JSX.Element {
  const t = useTranslate()
  const [text, setText] = useState('')
  useEffect(() => {
    if (!active) {
      setText('')
      return
    }
    const message =
      count === 0 && pausedCount > 0
        ? ''
        : count === 0
          ? t('bots.search.noMatches', 'No matches')
          : t('bots.search.matchCount', '{{count}} matches', {
              count,
              defaultValue_one: '{{count}} match'
            })
    const paused =
      pausedCount > 0
        ? t('bots.search.pausedMatches', '{{count}} paused matches', {
            count: pausedCount,
            defaultValue_one: '{{count}} paused match'
          })
        : null
    // One message when both are spoken, so a language can order and join them its own way.
    const announcement =
      message && paused
        ? t('bots.search.announcement', '{{matches}}. {{paused}}', { matches: message, paused })
        : message || paused || ''
    const timer = window.setTimeout(() => setText(announcement), ANNOUNCE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [active, count, pausedCount, t])
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {text}
    </div>
  )
}
