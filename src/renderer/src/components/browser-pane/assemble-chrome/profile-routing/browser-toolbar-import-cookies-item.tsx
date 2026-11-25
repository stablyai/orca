import { Import } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserPageCookieImportRoute } from '@/store/slices/browser/browser-slice-contract'

export type DetectedBrowserEntry = {
  family: string
  label: string
  profiles: { name: string; directory: string }[]
  selectedProfile: string
}

export type BrowserToolbarImportCookiesProps = {
  browserPageId: string
  /** Cookies always land in the page's current profile. */
  effectiveProfileId: string
  detectedBrowsers: DetectedBrowserEntry[]
  detectedBrowsersLoaded: boolean
  onFetchDetectedBrowsers: () => void
  browserSessionImportState: { profileId: string; status: string } | null | undefined
  /** The page's own jar, which the import fills. */
  pageRoute: BrowserPageCookieImportRoute
  /** The search picker the row opens, anchored to the ⋯ button. */
  pickerOpen: boolean
  onPickerOpenChange: (open: boolean) => void
  onImportFromBrowser: (browserFamily: string, browserProfile?: string) => void
  onImportFromFile: () => void
}

const keepFocusOffMenuTrigger = (): void => {}

/** Import Cookies… sits at the top of the ⋯ menu: without logins the browser is of little use. */
export function BrowserToolbarImportCookiesItem({
  effectiveProfileId,
  browserSessionImportState,
  onFetchDetectedBrowsers,
  onPickerOpenChange,
  deferUntilClose
}: Pick<
  BrowserToolbarImportCookiesProps,
  | 'effectiveProfileId'
  | 'browserSessionImportState'
  | 'onFetchDetectedBrowsers'
  | 'onPickerOpenChange'
> & {
  deferUntilClose: (action: () => void) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuItem
      disabled={
        browserSessionImportState?.profileId === effectiveProfileId &&
        browserSessionImportState.status === 'importing'
      }
      data-contextual-tour-target="browser-import-cookies-control"
      onSelect={() => {
        // Defer macOS app-data profile probes until the user opens Import.
        onFetchDetectedBrowsers()
        // The picker opens now and takes focus; returning it to ⋯ as the menu closes would dismiss it.
        deferUntilClose(keepFocusOffMenuTrigger)
        onPickerOpenChange(true)
      }}
    >
      <Import className="size-3.5" />
      {t('browser.cookieImport.picker.menuItem', 'Import Cookies…')}
    </DropdownMenuItem>
  )
}
