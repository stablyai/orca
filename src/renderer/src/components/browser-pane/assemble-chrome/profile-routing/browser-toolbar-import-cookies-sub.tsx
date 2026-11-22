import { Import } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { BrowserCookieImportDisclosure } from '@/components/settings/browser/profiles/BrowserCookieImportDisclosure'
import { BrowserCookieImportMachineNotice } from '@/components/settings/browser/profiles/BrowserCookieImportMachineNotice'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserSshPageCookieImportRoute } from '@/store/slices/browser/browser-slice-contract'

export type DetectedBrowserEntry = {
  family: string
  label: string
  profiles: { name: string; directory: string }[]
  selectedProfile: string
}

export type BrowserToolbarImportCookiesSubProps = {
  browserPageId: string
  /** Cookies always land in the page's current profile. */
  effectiveProfileId: string
  detectedBrowsers: DetectedBrowserEntry[]
  onFetchDetectedBrowsers: () => void
  browserSessionImportState: { profileId: string; status: string } | null | undefined
  /** Set when the page browses through an SSH host, whose jar the import fills. */
  sshRoute: BrowserSshPageCookieImportRoute | null
  onImportFromBrowser: (browserFamily: string, browserProfile?: string) => void
  onImportFromFile: () => void
}

/** Import Cookies › sits at the top of the ⋯ menu: without logins the browser is of little use. */
export function BrowserToolbarImportCookiesSub({
  browserPageId,
  effectiveProfileId,
  detectedBrowsers,
  onFetchDetectedBrowsers,
  browserSessionImportState,
  sshRoute,
  onImportFromBrowser,
  onImportFromFile
}: BrowserToolbarImportCookiesSubProps): React.JSX.Element {
  const t = useTranslate()
  const fromBrowserLabel = (label: string): string =>
    t('auto.components.browser.pane.BrowserToolbarMenu.eb280bfb11', 'From {{value0}}', {
      value0: label
    })
  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (open) {
          // Defer macOS app-data profile probes until the user opens Import.
          onFetchDetectedBrowsers()
        }
      }}
    >
      <DropdownMenuSubTrigger
        disabled={
          browserSessionImportState?.profileId === effectiveProfileId &&
          browserSessionImportState.status === 'importing'
        }
        data-contextual-tour-target="browser-import-cookies-control"
      >
        <Import className="size-3.5" />
        {t('auto.components.browser.pane.BrowserToolbarMenu.2293adf620', 'Import Cookies')}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent data-browser-page-menu-id={browserPageId}>
          <BrowserCookieImportMachineNotice sshRoute={sshRoute} />
          {detectedBrowsers.map((browser) =>
            browser.profiles.length > 1 ? (
              <DropdownMenuSub key={browser.family}>
                <DropdownMenuSubTrigger>{fromBrowserLabel(browser.label)}</DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent data-browser-page-menu-id={browserPageId}>
                    {browser.profiles.map((profile) => (
                      <DropdownMenuItem
                        key={profile.directory}
                        onSelect={() => onImportFromBrowser(browser.family, profile.directory)}
                      >
                        {profile.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem
                key={browser.family}
                onSelect={() => onImportFromBrowser(browser.family)}
              >
                {fromBrowserLabel(browser.label)}
              </DropdownMenuItem>
            )
          )}
          {detectedBrowsers.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={onImportFromFile}>
            {t('auto.components.browser.pane.BrowserToolbarMenu.56f94f4ffa', 'From File…')}
          </DropdownMenuItem>
          <BrowserCookieImportDisclosure />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}
