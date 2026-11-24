import { useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { BrowserCookieImportMachineNotice } from '@/components/settings/browser/profiles/BrowserCookieImportMachineNotice'
import { isImeCompositionKeyDown } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserToolbarImportCookiesProps } from './browser-toolbar-import-cookies-item'
import {
  buildBrowserCookieImportPickerSections,
  type BrowserCookieImportPickerRow
} from './browser-cookie-import-picker-rows'
import {
  readBrowserCookieImportLastUsed,
  rememberBrowserCookieImportLastUsed
} from './browser-cookie-import-last-used'
import {
  FROM_FILE_VALUE,
  getPickerSelection,
  INITIAL_PICKER_SEARCH,
  reducePickerSearch
} from './browser-cookie-import-picker-selection'

// A cmdk value no row has, so nothing is highlighted.
const NO_HIGHLIGHT = '\u001fnone\u001f'

// About seven and a half rows, so a long list shows half of the next row as its scroll cue.
const LIST_SCROLL_CLASS = 'max-h-[249px] space-y-[6px] overflow-y-auto scrollbar-sleek'

/** Keys cmdk moves the highlight with (its vim bindings included). */
function isHighlightKey(event: React.KeyboardEvent): boolean {
  return (
    ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
    (event.ctrlKey && ['n', 'j', 'p', 'k'].includes(event.key))
  )
}

/** As cmdk does, but for the row now highlighted: a section's first row brings its label along. */
function scrollRowIntoView(list: HTMLElement | null, value: string): void {
  // By value, since cmdk marks the row aria-selected only after this commit.
  const row = [...(list?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? [])].find(
    (el) => el.getAttribute('data-value') === value
  )
  if (!row) {
    return
  }
  if (row.parentElement?.firstElementChild === row) {
    row
      .closest('[cmdk-group]')
      ?.querySelector('[cmdk-group-heading]')
      ?.scrollIntoView({ block: 'nearest' })
  }
  row.scrollIntoView({ block: 'nearest' })
}

type BrowserCookieImportPickerProps = Pick<
  BrowserToolbarImportCookiesProps,
  | 'browserPageId'
  | 'detectedBrowsers'
  | 'detectedBrowsersLoaded'
  | 'pageRoute'
  | 'onImportFromBrowser'
  | 'onImportFromFile'
> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The ⋯ button: the picker hangs from it and gives focus back to it. */
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

/** Import Cookies… opens this: search on top, profiles grouped by browser, From File… last. */
export function BrowserCookieImportPicker({
  open,
  onOpenChange,
  anchorRef,
  browserPageId,
  ...body
}: BrowserCookieImportPickerProps): React.JSX.Element {
  const closedOutsideRef = useRef(false)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM refs are transiently null before mount, though Radix's virtualRef type omits that lifecycle state.
        virtualRef={anchorRef as React.RefObject<HTMLButtonElement>}
      />
      <PopoverContent
        align="end"
        collisionPadding={8}
        tone="menu"
        className="w-[260px] max-w-[calc(100vw-16px)]"
        data-browser-page-menu-id={browserPageId}
        data-testid="browser-cookie-import-picker"
        onInteractOutside={() => {
          closedOutsideRef.current = true
        }}
        onCloseAutoFocus={(event) => {
          // An anchor is not a trigger, so Radix has nothing to return focus to. A click elsewhere
          // keeps focus where it landed, as Radix does for a trigger.
          event.preventDefault()
          if (!closedOutsideRef.current) {
            anchorRef.current?.focus()
          }
          closedOutsideRef.current = false
        }}
      >
        <BrowserCookieImportPickerBody {...body} onClose={() => onOpenChange(false)} />
      </PopoverContent>
    </Popover>
  )
}

function BrowserCookieImportPickerBody({
  detectedBrowsers,
  detectedBrowsersLoaded,
  pageRoute,
  onImportFromBrowser,
  onImportFromFile,
  onClose
}: Omit<BrowserCookieImportPickerProps, 'open' | 'onOpenChange' | 'anchorRef' | 'browserPageId'> & {
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [search, updateSearch] = useReducer(reducePickerSearch, INITIAL_PICKER_SEARCH)
  const { query } = search
  // Mounted per open, so a source picked in another pane shows here next time.
  const [lastUsed] = useState(readBrowserCookieImportLastUsed)
  const sections = useMemo(
    () => buildBrowserCookieImportPickerSections(detectedBrowsers, lastUsed, query),
    [detectedBrowsers, lastUsed, query]
  )
  const rowValues = [...sections.flatMap((s) => s.rows.map((r) => r.value)), FROM_FILE_VALUE]
  const hasSearch = query.trim() !== ''
  const onlyFromFile = sections.length === 0
  const noMatches = onlyFromFile && hasSearch && detectedBrowsersLoaded
  const rowsKey = JSON.stringify(rowValues)
  const [selectionReset, setSelectionReset] = useState(0)
  const explicitSelection = useRef(false)
  const selected = getPickerSelection(search, rowsKey)
  const highlighted = onlyFromFile
    ? (selected ?? `${NO_HIGHLIGHT}${selectionReset}`)
    : (selected ?? rowValues[0])
  const markExplicitSelection = (): void => {
    explicitSelection.current = true
  }
  const listRef = useRef<HTMLDivElement>(null)
  // cmdk scrolls before a controlled highlight re-renders, so it would scroll the previous row.
  useLayoutEffect(() => scrollRowIntoView(listRef.current, highlighted), [highlighted])

  const importRow = (row: BrowserCookieImportPickerRow): void => {
    rememberBrowserCookieImportLastUsed(row.source)
    onClose()
    onImportFromBrowser(row.source.family, row.source.profile ?? undefined)
  }
  const searchLabel = t('browser.cookieImport.picker.search', 'Search profiles')

  return (
    <Command
      shouldFilter={false}
      loop={onlyFromFile}
      value={highlighted}
      onValueChange={(value) => {
        const byUser = explicitSelection.current
        explicitSelection.current = false
        if (!onlyFromFile || byUser) {
          updateSearch({
            type: 'select',
            selection: { rowsKey, value: rowValues.includes(value) ? value : rowValues[0] }
          })
        } else if (!selected) {
          // cmdk selects its first row on search changes. A new value clears that selection.
          setSelectionReset((count) => count + 1)
        }
      }}
      onKeyDown={(event) => {
        if (!onlyFromFile || selected || isImeCompositionKeyDown(event)) {
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
        } else if (isHighlightKey(event)) {
          markExplicitSelection()
        }
      }}
      label={t('browser.cookieImport.picker.menuItem', 'Import Cookies…')}
      surface="menu"
    >
      <CommandInput
        value={query}
        onValueChange={(value) => {
          explicitSelection.current = false
          updateSearch({ type: 'edit-query', query: value })
        }}
        placeholder={searchLabel}
        aria-label={searchLabel}
        variant="menu"
        wrapperClassName="mb-[6px]"
      />
      <CommandList ref={listRef} className="max-h-none overflow-visible">
        <BrowserCookieImportMachineNotice pageRoute={pageRoute} />
        <div className={LIST_SCROLL_CLASS} aria-busy={!detectedBrowsersLoaded}>
          {sections.map((section) => (
            <CommandGroup
              key={section.key}
              variant="menu"
              heading={
                section.kind === 'last-used'
                  ? t('browser.cookieImport.picker.lastUsed', 'Last used')
                  : (section.browserLabel ?? undefined)
              }
            >
              {section.rows.map((row) => (
                <CommandItem
                  key={row.value}
                  value={row.value}
                  density="menu"
                  selection="menu"
                  onSelect={() => importRow(row)}
                >
                  <span className="min-w-0 truncate">{row.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {noMatches ? (
            <div className="px-2.5 py-[5px] text-[13px] leading-4 text-muted-foreground">
              {t('browser.cookieImport.picker.noMatches', 'No matches')}
            </div>
          ) : null}
        </div>
        {!onlyFromFile || noMatches ? <CommandSeparator alwaysRender variant="menu" /> : null}
        <CommandItem
          value={FROM_FILE_VALUE}
          density="menu"
          selection="menu"
          onPointerMoveCapture={onlyFromFile && !selected ? markExplicitSelection : undefined}
          onSelect={() => {
            onClose()
            onImportFromFile()
          }}
        >
          {t('auto.components.browser.pane.BrowserToolbarMenu.56f94f4ffa', 'From File…')}
        </CommandItem>
        <CommandSeparator alwaysRender variant="menu" />
        <p className="flex items-center gap-2 px-2.5 py-[5px] text-[12px] leading-4 text-muted-foreground">
          <Info aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0">
            {t('browser.cookieImport.picker.googleNote', 'Google logins aren’t imported')}
          </span>
        </p>
      </CommandList>
    </Command>
  )
}
