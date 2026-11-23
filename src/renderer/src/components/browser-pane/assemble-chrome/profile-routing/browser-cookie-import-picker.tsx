import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { MENU_LABEL_CLASS, menuSeparatorVariants } from '@/components/ui/menu-item'
import { MENU_SURFACE_CLASS } from '@/components/ui/menu-surface'
import { BrowserCookieImportDisclosure } from '@/components/settings/browser/profiles/BrowserCookieImportDisclosure'
import { BrowserCookieImportMachineNotice } from '@/components/settings/browser/profiles/BrowserCookieImportMachineNotice'
import { cn } from '@/lib/class-names'
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

const FROM_FILE_VALUE = 'from-file'

// Menu row tokens (26px rows, 10px inset, menu hover), on cmdk's highlight instead of focus.
const PICKER_ROW_CLASS =
  'gap-2 rounded-md px-2.5 py-[5px] text-[13px] leading-4 data-[selected=true]:bg-black/8 data-[selected=true]:text-popover-foreground dark:data-[selected=true]:bg-white/14'

// Eight rows plus two section labels, then the list scrolls.
const LIST_SCROLL_CLASS = 'max-h-[252px] overflow-y-auto scrollbar-sleek'

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
  'browserPageId' | 'detectedBrowsers' | 'pageRoute' | 'onImportFromBrowser' | 'onImportFromFile'
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
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM refs are transiently null before mount, though Radix's virtualRef type omits that lifecycle state.
        virtualRef={anchorRef as React.RefObject<HTMLButtonElement>}
      />
      <PopoverContent
        align="end"
        collisionPadding={8}
        className={cn(MENU_SURFACE_CLASS, 'w-[260px] max-w-[calc(100vw-16px)]')}
        data-browser-page-menu-id={browserPageId}
        data-testid="browser-cookie-import-picker"
        onCloseAutoFocus={(event) => {
          // An anchor is not a trigger, so Radix has nothing to return focus to.
          event.preventDefault()
          anchorRef.current?.focus()
        }}
      >
        <BrowserCookieImportPickerBody {...body} onClose={() => onOpenChange(false)} />
      </PopoverContent>
    </Popover>
  )
}

function BrowserCookieImportPickerBody({
  detectedBrowsers,
  pageRoute,
  onImportFromBrowser,
  onImportFromFile,
  onClose
}: Omit<BrowserCookieImportPickerProps, 'open' | 'onOpenChange' | 'anchorRef' | 'browserPageId'> & {
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  // Mounted per open, so a source picked in another pane shows here next time.
  const [lastUsed] = useState(readBrowserCookieImportLastUsed)
  const sections = useMemo(
    () => buildBrowserCookieImportPickerSections(detectedBrowsers, lastUsed, query),
    [detectedBrowsers, lastUsed, query]
  )
  const rowValues = [...sections.flatMap((s) => s.rows.map((r) => r.value)), FROM_FILE_VALUE]
  // Typing or browsers arriving from the lazy probe puts the highlight back on the first row.
  const rowsKey = rowValues.join('\n')
  const [highlight, setHighlight] = useState<{
    rowsKey: string
    value: string
  } | null>(null)
  const highlighted =
    highlight && highlight.rowsKey === rowsKey && rowValues.includes(highlight.value)
      ? highlight.value
      : rowValues[0]
  const listRef = useRef<HTMLDivElement>(null)
  // cmdk scrolls before a controlled highlight re-renders, so it would scroll the previous row.
  useLayoutEffect(() => scrollRowIntoView(listRef.current, highlighted), [highlighted])

  const importRow = (row: BrowserCookieImportPickerRow): void => {
    rememberBrowserCookieImportLastUsed(row.source)
    onClose()
    onImportFromBrowser(row.source.family, row.source.profile ?? undefined)
  }
  const searchLabel = t('browser.cookieImport.picker.search', 'Search profiles')
  const hasSearch = query.trim() !== ''

  return (
    <Command
      shouldFilter={false}
      loop={false}
      value={highlighted}
      onValueChange={(value) => setHighlight({ rowsKey, value })}
      label={t('browser.cookieImport.picker.menuItem', 'Import Cookies…')}
      surface="inline"
      className="rounded-none"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={searchLabel}
        aria-label={searchLabel}
        // Text starts where row text does: the field's inset is the rows' 10px.
        wrapperClassName="mb-[6px] h-8 border-black/7 bg-transparent px-2.5 py-0 dark:border-white/10"
        iconClassName="hidden"
        className="h-8 py-0 text-[13px]"
      />
      <CommandList ref={listRef} className="max-h-none overflow-visible">
        <BrowserCookieImportMachineNotice pageRoute={pageRoute} />
        <div className={LIST_SCROLL_CLASS}>
          {sections.map((section) => (
            <CommandGroup
              key={section.key}
              heading={
                section.browserLabel ?? t('browser.cookieImport.picker.lastUsed', 'Last used')
              }
              className={cn(
                'p-0',
                '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-[5px] [&_[cmdk-group-heading]]:pb-[3px] [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold'
              )}
            >
              {section.rows.map((row) => (
                <CommandItem
                  key={row.value}
                  value={row.value}
                  className={PICKER_ROW_CLASS}
                  onSelect={() => importRow(row)}
                >
                  <span className="min-w-0 truncate">{row.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {sections.length === 0 && hasSearch ? (
            <div role="presentation" className={MENU_LABEL_CLASS}>
              {t('browser.cookieImport.picker.noMatches', 'No matches')}
            </div>
          ) : null}
        </div>
        {sections.length > 0 || hasSearch ? (
          <CommandSeparator alwaysRender className={menuSeparatorVariants()} />
        ) : null}
        <CommandItem
          value={FROM_FILE_VALUE}
          className={PICKER_ROW_CLASS}
          onSelect={() => {
            onClose()
            onImportFromFile()
          }}
        >
          {t('auto.components.browser.pane.BrowserToolbarMenu.56f94f4ffa', 'From File…')}
        </CommandItem>
        <BrowserCookieImportDisclosure />
      </CommandList>
    </Command>
  )
}
