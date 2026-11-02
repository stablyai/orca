import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { FileText, Trash2 } from 'lucide-react'
import { BrowserFavicon } from '@/components/browser-favicon'
import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { FooterKey } from '@/components/worktree-jump-palette-primitives'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { requestBrowserFocus } from '../host-guest/browser-focus'
import type { BrowserPageDocLocation } from '../../../../../shared/browser-workspace-types'
import { startOfLocalDay } from '../../../../../shared/automation-cron-occurrence'
import { formatKeybinding } from '../../../../../shared/keybindings/formatting'
import type { RemovedBrowserHistory } from '@/store/slices/browser/browser-slice-contract'
import type { BrowserAddressBarSuggestion } from '../assemble-chrome/browser-address-bar-suggestions'
import BrowserHistoryRowRemoveButton from './BrowserHistoryRowRemoveButton'
import { isRemoveRowShortcut, useRemoveHistoryRow } from './browser-history-row-removal'
import {
  browserHistoryClearSince,
  browserHistoryRowKey,
  groupBrowserHistoryRowsByDay,
  listBrowserHistoryRows,
  type BrowserHistoryClearRange
} from './browser-history-view-rows'

type BrowserHistoryDialogProps = {
  pageId: string
  onNavigate: (url: string) => void
  onOpenWorkspaceDoc?: (docLocation: BrowserPageDocLocation) => void
}

/** Rendered by every address bar; only the page the history view was opened for shows it. */
export default function BrowserHistoryDialog(
  props: BrowserHistoryDialogProps
): React.JSX.Element | null {
  const open = useAppStore((s) => s.browserHistoryPageId === props.pageId)
  return open ? <BrowserHistoryDialogContent {...props} /> : null
}

// Why cached per locale: the UI language can change while the app runs.
let historyFormats: {
  locale: string
  dateFormat: Intl.DateTimeFormat
  timeFormat: Intl.DateTimeFormat
} | null = null

function getHistoryFormats(): NonNullable<typeof historyFormats> {
  const locale = getIntlLocale()
  if (historyFormats?.locale !== locale) {
    historyFormats = {
      locale,
      dateFormat: new Intl.DateTimeFormat(locale, { dateStyle: 'full' }),
      timeFormat: new Intl.DateTimeFormat(locale, { timeStyle: 'short' })
    }
  }
  return historyFormats
}

function formatDayHeading(startsAt: number, now: number, dateFormat: Intl.DateTimeFormat): string {
  const today = startOfLocalDay(now)
  if (startsAt === today) {
    return translate('browser.history.today', 'Today')
  }
  if (startsAt === startOfLocalDay(today - 1)) {
    return translate('browser.history.yesterday', 'Yesterday')
  }
  return dateFormat.format(startsAt)
}

const CLEAR_RANGES: readonly BrowserHistoryClearRange[] = ['hour', 'today', 'all']

function clearRangeLabel(range: BrowserHistoryClearRange): string {
  if (range === 'hour') {
    return translate('browser.history.clearLastHour', 'Last hour')
  }
  return range === 'today'
    ? translate('browser.history.clearToday', 'Today')
    : translate('browser.history.clearAllTime', 'All time')
}

function BrowserHistoryDialogContent({
  pageId,
  onNavigate,
  onOpenWorkspaceDoc
}: BrowserHistoryDialogProps): React.JSX.Element {
  const browserUrlHistory = useAppStore((s) => s.browserUrlHistory)
  const workspaceDocHistory = useAppStore((s) => s.workspaceDocHistory)
  const setBrowserHistoryPageId = useAppStore((s) => s.setBrowserHistoryPageId)
  const clearBrowserHistory = useAppStore((s) => s.clearBrowserHistory)
  const restoreBrowserHistory = useAppStore((s) => s.restoreBrowserHistory)
  const removeHistoryRow = useRemoveHistoryRow()
  const [query, setQuery] = useState('')
  // Why in the footer and not a toast: the modal overlay covers the app's toaster.
  const [cleared, setCleared] = useState<RemovedBrowserHistory | null>(null)
  const deferredQuery = useDeferredValue(query)
  const [now] = useState(() => Date.now())
  const rows = useMemo(
    () => listBrowserHistoryRows(browserUrlHistory, workspaceDocHistory, deferredQuery),
    [browserUrlHistory, workspaceDocHistory, deferredQuery]
  )
  const days = useMemo(() => groupBrowserHistoryRowsByDay(rows), [rows])
  const { dateFormat, timeFormat } = getHistoryFormats()
  const openedRowRef = useRef(false)
  const close = (): void => setBrowserHistoryPageId(null)

  const openRow = (row: BrowserAddressBarSuggestion): void => {
    openedRowRef.current = true
    close()
    if (row.docLocation && onOpenWorkspaceDoc) {
      onOpenWorkspaceDoc(row.docLocation)
    } else {
      onNavigate(row.url)
    }
  }

  const clear = (range: BrowserHistoryClearRange): void => {
    const removed = clearBrowserHistory(browserHistoryClearSince(range))
    if (removed.browserUrlHistory.length === 0 && removed.workspaceDocHistory.length === 0) {
      return
    }
    setCleared(removed)
  }

  const hasHistory = browserUrlHistory.length > 0 || workspaceDocHistory.length > 0
  return (
    <CommandDialog
      open
      onOpenChange={(next) => !next && close()}
      shouldFilter={false}
      onCloseAutoFocus={(event) => {
        if (!openedRowRef.current) {
          return
        }
        // Request page focus after dialog teardown so its focus trap cannot pull it back.
        event.preventDefault()
        requestBrowserFocus({ pageId, target: 'webview' })
      }}
      title={translate('browser.history.title', 'History')}
      description={translate('browser.history.description', 'Search and manage browsing history')}
      contentClassName="top-[min(10%,4rem)] w-[720px] max-w-[96vw] overflow-hidden"
      commandProps={{
        loop: true,
        className: 'jump-palette-command bg-transparent',
        onKeyDownCapture: (event: React.KeyboardEvent<HTMLDivElement>) => {
          if (!isRemoveRowShortcut(event)) {
            return
          }
          // Why read from cmdk: tracking its selection in state would re-render every row per hover.
          const selectedKey = event.currentTarget
            .querySelector('[cmdk-item][data-selected="true"]')
            ?.getAttribute('data-value')
          const selected = rows.find((row) => browserHistoryRowKey(row) === selectedKey)
          if (selected) {
            event.preventDefault()
            event.stopPropagation()
            removeHistoryRow(selected)
          }
        }
      }}
    >
      <CommandInput
        placeholder={translate('browser.history.search', 'Search history')}
        value={query}
        onValueChange={setQuery}
        className="h-11 min-w-0 flex-1"
      />
      <CommandList className="max-h-[min(560px,calc(100vh-14rem))]">
        <CommandEmpty>
          {hasHistory
            ? translate('browser.history.noMatches', 'No pages match your search')
            : translate('browser.history.empty', 'Pages you visit will show up here')}
        </CommandEmpty>
        {days.map((day) => (
          <CommandGroup
            key={day.startsAt}
            heading={formatDayHeading(day.startsAt, now, dateFormat)}
          >
            {day.rows.map((row) => {
              const key = browserHistoryRowKey(row)
              return (
                <CommandItem
                  key={key}
                  value={key}
                  onSelect={() => openRow(row)}
                  className="cursor-pointer"
                >
                  {row.docLocation ? (
                    <FileText className="size-3.5 text-muted-foreground" />
                  ) : (
                    <BrowserFavicon
                      faviconUrl={row.faviconUrl}
                      className="size-3.5"
                      fallbackClassName="text-muted-foreground"
                    />
                  )}
                  <div className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="truncate text-[13px] text-foreground">
                      {row.title || row.url}
                    </span>
                    <span className="min-w-0 shrink-[2] truncate text-xs text-muted-foreground">
                      {row.subtitle}
                    </span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {timeFormat.format(row.lastVisitedAt)}
                  </span>
                  <BrowserHistoryRowRemoveButton onRemove={() => removeHistoryRow(row)} />
                </CommandItem>
              )
            })}
          </CommandGroup>
        ))}
      </CommandList>
      <div
        className="flex items-center justify-between border-t border-border/60 px-3.5 py-2 text-2xs text-muted-foreground"
        // Keep footer keys away from cmdk row navigation; Tab still reaches the dialog focus loop.
        onKeyDown={(event) => event.key !== 'Tab' && event.stopPropagation()}
      >
        {cleared ? (
          <div className="flex items-center gap-2">
            <span>{translate('browser.history.cleared', 'Cleared browsing history')}</span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                restoreBrowserHistory(cleared)
                setCleared(null)
              }}
            >
              {translate('browser.newTab.undo', 'Undo')}
            </Button>
          </div>
        ) : (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" disabled={!hasHistory}>
                <Trash2 />
                {translate('browser.history.clear', 'Clear browsing history')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuLabel>
                {translate('browser.history.clearRange', 'Clear history from')}
              </DropdownMenuLabel>
              {CLEAR_RANGES.map((range) => (
                <DropdownMenuItem key={range} onSelect={() => clear(range)}>
                  {clearRangeLabel(range)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="flex items-center gap-2">
          <FooterKey>{translate('browser.history.enterKey', 'Enter')}</FooterKey>
          <span>{translate('browser.history.open', 'Open')}</span>
          <FooterKey>{formatKeybinding('Shift+Delete', getShortcutPlatform()).join(' ')}</FooterKey>
          <span>{translate('browser.history.removeShort', 'Remove')}</span>
          <FooterKey>{translate('browser.history.escKey', 'Esc')}</FooterKey>
          <span>{translate('browser.history.close', 'Close')}</span>
        </div>
      </div>
    </CommandDialog>
  )
}
